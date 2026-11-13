// app/lib/conductor-staff-check.ts — 自信が無い時に統括が人に回す段（純関数・DB も LLM も持たない）
//
// 2026-11-13 作業員5（統括役の頼み・前の作業員4 の持ち場）: 入口の統括の自信（conductor-intake の confidence）が low の番で、
//   はっきりした理由が1つでもある時だけ、統括が「スタッフに確かめてもらう」と決める。
//   その番は下書きを無理に言い切らせず（on の時だけ書き手に1行）、理由をスタッフ向けの画面の注記に1行残す
//   （注記は最終チェックの結果 final_check.staff_check に入れる。下書き欄には入れない＝AI の作業メモは下書きに書かない決まり）。
//
// 理由の名前（人へ回す理由）は自動返信の段（KB e781a122「確かな番だけ自動・残りは理由を付けて人へ」）と同じ物を使う:
//   影の関所（shadow-auto-gate.ts）は final_check.staff_check の理由を、そのまま止めた線（lines）に入れる。親の線は本物の関所の low_confidence。
//   ref_unresolved   指す物が解けない（深さの札「指す物が複数」・点検役 12105 送った側の取り違え・10911 画像の物件名が空）
//   answer_guess_only 答えの出所が推測だけ（latent_five の guess・turn_contract の basis が general/judgement だけ）
//   reading_split    読みの候補が割れた（read_candidates が2つ以上で、事実で1つに決まっていない）
// 指す物の確かさは作業員16 の ref_resolve（meta.ref_resolve）が入ったらそれを使う。今は持ち込みの画像に物件名が無い番だけを決まった形で見る。
// 切替: CONDUCTOR_STAFF_CHECK=shadow（記録と画面の注記だけ）／on（＋書き手に「言い切らない」の1行）。既定 off。
// テスト: app/lib/__tests__/conductor-staff-check.test.ts

export type StaffCheckMode = "off" | "shadow" | "on";
export function staffCheckMode(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): StaffCheckMode {
  const v = (env.CONDUCTOR_STAFF_CHECK ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "shadow" ? "shadow" : "off";
}

export const STAFF_CHECK_REASONS = ["ref_unresolved", "answer_guess_only", "reading_split"] as const;
export type StaffCheckReason = typeof STAFF_CHECK_REASONS[number];
/** 親の線（本物の関所 auto-reply-policy の理由） */
export const STAFF_CHECK_GATE_REASON = "low_confidence";
export const STAFF_CHECK_REASON_JA: Record<StaffCheckReason, string> = {
  ref_unresolved: "指す物が解けない",
  answer_guess_only: "答えの出所が推測だけ",
  reading_split: "読みの候補が割れた",
};
/** 深さの札（brain-depth.decideBrainDepth の reason）→ 人へ回す理由（その札の番で理由が立った時に、深さの記録と並べて数えるため） */
export const DEPTH_REASON_TO_STAFF_CHECK: Partial<Record<string, StaffCheckReason>> = {
  "指す物が複数": "ref_unresolved",
  "持ち込み": "ref_unresolved",
  "疑い": "answer_guess_only",
};

export type StaffCheckInput = {
  /** 入口の統括の自信（conductor_intake.answer.confidence） */
  intakeConfidence: string | null | undefined;
  /** 作業員16 の ref_resolve（meta.ref_resolve・REF_RESOLVE=on|shadow の時だけ）。handoff に ref_needs_name／ref_needs_room があれば解けない（resolved=false・sure=low も同じ） */
  ref?: { resolved?: boolean | null; sure?: string | null; handoff?: ReadonlyArray<unknown> | null } | null;
  /** 今の番にお客様の画像がある（持ち込み） */
  turnHasImage?: boolean;
  /** ブレインが決めた今の番の物件（current_property）。画像の番でこれが空なら物件名が読めていない（10911） */
  currentProperty?: string | null;
  /** 判断のブレインの turn_contract.asks */
  asks?: ReadonlyArray<{ route?: unknown; basis?: unknown }> | null;
  /** latent_five（出所の付いた潜在の読み） */
  latentFive?: { object?: { src?: unknown } | null; concern?: { src?: unknown } | null; reason?: { guess?: unknown } | null } | null;
  /** read_candidates（brain-read-candidates） */
  readCandidates?: { turn?: unknown; options?: ReadonlyArray<unknown>; chosen?: unknown; by?: unknown } | null;
  /** 深さの札（brain_depth.reason）。記録に並べるだけ（判断には使わない） */
  depthReason?: string | null;
};
export type StaffCheck = { reasons: StaffCheckReason[]; gate: typeof STAFF_CHECK_GATE_REASON; note: string; depth: string | null; depth_match: boolean; ref_detail?: RefHandoffName[] };
/** 作業員16 の ref-resolve.REF_HANDOFF_REASONS と同じ名前（ref-resolve を読み込まない＝その部品が main に入る前でも動く・テストで名前を確かめる） */
export const REF_HANDOFF_NAMES = ["ref_needs_name", "ref_needs_room"] as const;
export type RefHandoffName = typeof REF_HANDOFF_NAMES[number];

const FACT_BY_RE = /直前|送信|送った|お送り|約束|ピックアップ|見積|内覧|日時|会社|資料|物件|条件/;

/**
 * 統括の決め: 自信が low で、はっきりした理由が1つ以上ある時だけ（理由の無い low は今まで通り＝人に回さない）。
 *   例外: ref_resolve が人へ回すと書いた番（ref_needs_name／ref_needs_room）は自信に関係なく回す（統括役 11/13 の決め「この番はブレインが言い切らず、スタッフが確かめる番」）
 */
export function decideStaffCheck(i: StaffCheckInput): StaffCheck | null {
  const refDetail = (Array.isArray(i.ref?.handoff) ? i.ref!.handoff : []).map(String).filter((x): x is RefHandoffName => (REF_HANDOFF_NAMES as readonly string[]).includes(x));
  if (String(i.intakeConfidence ?? "").trim() !== "low" && !refDetail.length) return null;
  const reasons: StaffCheckReason[] = [];
  // ① 指す物が解けない
  const refBad = !!i.ref && (refDetail.length > 0 || i.ref.resolved === false || String(i.ref.sure ?? "") === "low");
  const imageNoName = !i.ref && !!i.turnHasImage && !String(i.currentProperty ?? "").trim();
  if (refBad || imageNoName) reasons.push("ref_unresolved");
  // ② 答えの出所が推測だけ: 返信で答える依頼が全部 general/judgement/無し、または潜在の読みの段が全部 guess
  const replyAsks = (i.asks ?? []).filter((a) => String(a?.route ?? "") === "reply");
  const asksGuess = replyAsks.length > 0 && replyAsks.every((a) => ["general", "judgement", "", "null", "undefined"].includes(String(a?.basis ?? "")));
  const lf = i.latentFive;
  const lfStages = lf ? [lf.object ? String(lf.object.src ?? "") === "guess" : null, lf.concern ? String(lf.concern.src ?? "") === "guess" : null, lf.reason ? lf.reason.guess === true : null].filter((x): x is boolean => x !== null) : [];
  const lfGuess = lfStages.length > 0 && lfStages.every(Boolean);
  if (asksGuess || lfGuess) reasons.push("answer_guess_only");
  // ③ 読みの候補が割れた: 候補が2つ以上で、選べていない・決めた根拠が事実でない
  const rc = i.readCandidates;
  const opts = Array.isArray(rc?.options) ? rc!.options.filter((o) => String(o ?? "").trim()) : [];
  if (rc && String(rc.turn ?? "") !== "none" && opts.length >= 2) {
    const chosen = typeof rc.chosen === "number" && rc.chosen >= 0 && rc.chosen < opts.length;
    if (!chosen || !FACT_BY_RE.test(String(rc.by ?? ""))) reasons.push("reading_split");
  }
  // 自信が low でない番（ref_resolve の例外で来た番）は、指す物の理由だけ
  if (String(i.intakeConfidence ?? "").trim() !== "low") reasons.splice(0, reasons.length, ...reasons.filter((r) => r === "ref_unresolved"));
  if (!reasons.length) return null;
  const depth = i.depthReason ? String(i.depthReason).slice(0, 20) : null;
  return { reasons, gate: STAFF_CHECK_GATE_REASON, note: staffCheckNote(reasons), depth, depth_match: !!depth && reasons.includes(DEPTH_REASON_TO_STAFF_CHECK[depth] as StaffCheckReason), ...(refDetail.length ? { ref_detail: [...new Set(refDetail)] } : {}) };
}

/** スタッフ向けの画面の注記（1行・お客様には送らない） */
export function staffCheckNote(reasons: ReadonlyArray<StaffCheckReason>): string {
  return `🙋 統括の自信が低い番です（${reasons.map((r) => STAFF_CHECK_REASON_JA[r]).join("・")}）。送る前に確かめてください`;
}

/** on の時だけ書き手に渡す1行（下書きを無理に言い切らせない）。解けない理由ごとに、言い切ってはいけない物を書く */
export function staffCheckWriterLine(sc: StaffCheck | null): string {
  if (!sc) return "";
  const parts: string[] = [];
  if (sc.reasons.includes("ref_unresolved")) parts.push("どの物件の話か確かでないので、物件名・号室を推測で書かない");
  if (sc.reasons.includes("answer_guess_only")) parts.push("答えの出所が資料・会話・会社の事実に無い事は言い切らない");
  if (sc.reasons.includes("reading_split")) parts.push("相手の言いたい事の読みが1つに決まっていないので、読みを決めつけて答えない");
  return `【この番は言い切らない】${parts.join("。")}。分からない部分はスタッフが確かめるので、書ける事だけを書く。`;
}

/** 最終チェックの結果（final_check）から staff_check を読む（影の関所・画面が使う） */
export function staffCheckOf(check: unknown): { reasons: StaffCheckReason[]; note: string } | null {
  if (!check || typeof check !== "object") return null;
  const sc = (check as Record<string, unknown>).staff_check as { reasons?: unknown; note?: unknown } | undefined;
  if (!sc || !Array.isArray(sc.reasons)) return null;
  const reasons = sc.reasons.filter((r): r is StaffCheckReason => (STAFF_CHECK_REASONS as readonly string[]).includes(String(r)));
  return reasons.length ? { reasons, note: typeof sc.note === "string" ? sc.note : staffCheckNote(reasons) } : null;
}
