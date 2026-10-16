// app/lib/edited-turn-miner.ts — 大きく直された番を毎日拾う決まり（純関数・DB も fetch も LLM も持たない）
//
// 2026-10-16 竹内さん「毎日、AI の下書き（返信の下書き・AIX の文）と実際に送った文を比べ、大きく直された番を自動で拾う。
//   拾った番を ①新しい試験の問題（正解＝実際に送った文）②弱い所の候補の一覧（場面・どう直されたか・関係する設計知見の id）に使う。
//   竹内さんが画面を送らなくても、直された場面から弱い所が見つかり、試験の問題も毎日増える」。
//
// 重ねて作る（同じ物を二重に作らない）:
//   ・差の量と型 … app/lib/edit-diff.ts（classifyEdit・editLines・量の線 0.9/0.6/0.3＝save-reply-example と同じ）。「大きく」＝large/rewrite（近さ 0.6 未満）
//   ・返信の下書きと実送信の組 … 本番の見張り line_watch_turns（pickJudgeDraft で判定に使った下書き・返事のまとまり burst の手打ち）
//   ・AIX の生成文と実送信の組 … ai_reply_examples の entry_source='aix_action'（ai_draft↔sent_reply・automation-readiness と同じ材料）
//   ・人しか知らない事 … line-watch-judge.staffFactsOf（手打ちの AIX の中身・引用は外す）＋staff-confirm-facts.findStaffOnlyFact（下書きに無い物だけ）
//   ・ブレインの道の食い違い（返信か AIX か）は brain-gap-finder（週1）の持ち物。ここは「文がどう直されたか」
//   ・型の語の網 … scripts/audit-draft-gap-types.ts（2巡目の誤差の型）と同じ線を、行の対応（editLines）で数える
//
// 2つの箱:
//   reply_edit / aix_text_edit … 下書き・AIX の文を大きく直した（返信の外れ・AIX の文の外れ）
//   aix_turn … 実送信が人しか知らない事（管理会社の回答・空き・内覧の枠・待ち合わせ・見積の金額 等）を書いた番・スタッフが AIX を押した番。
//              返信の外れに数えない（竹内さん 10/16「人しか知らない所は AIX から送る」・設計知見 P0 4b744a33）
// 試験の問題にするのは竹内さんの番だけ（設計知見 ce349a3f「AIX の文の正解は竹内さんの送信・従業員の送信は正にしない」）。従業員の番は弱い所の一覧にだけ入る。
// 止める: EDITED_TURN_MINER=off（毎日の見張り・手で回すスクリプトの両方）
import { createHash } from "node:crypto";
import { classifyEdit, editLines, factTokensOf, type EditAmount } from "./edit-diff";

export type MinedSource = "reply" | "aix";
export type MinedBucket = "reply_edit" | "aix_text_edit" | "aix_turn";
export type EditType =
  | "rewrite" | "promise_escape" | "promise_added" | "vague_promise_cut" | "extra_cut" | "appeal_cut" | "appeal_added"
  | "greeting_added" | "greeting_cut" | "name_line_added" | "close_added" | "close_cut" | "residue" | "fact_fix"
  | "shorter" | "longer" | "other";

export const BUCKET_JA: Record<MinedBucket, string> = {
  reply_edit: "返信の下書きを大きく直した", aix_text_edit: "AIX の文を大きく直した", aix_turn: "AIX の番（人しか知らない事・AIX を押した）",
};
export const EDIT_TYPE_JA: Record<EditType, string> = {
  rewrite: "書き直し（近さ0.3未満＝場面・中身が違う）", promise_escape: "確認の約束に逃げた（人はその場で答えた）", promise_added: "人が確認の約束にした",
  vague_promise_cut: "対象のない約束を人が消した", extra_cut: "余計な一文（伴走・安心・嬉しい）を人が消した", appeal_cut: "内覧・申込の誘いを人が消した",
  appeal_added: "人が内覧・申込の誘いを足した", greeting_added: "人が挨拶を足した", greeting_cut: "人が挨拶を消した", name_line_added: "人が呼びかけの行を足した",
  close_added: "人が締めを足した", close_cut: "人が締めを消した", residue: "作業メモ・名残", fact_fix: "金額・日時・物件を直した",
  shorter: "人の方が3割以上短い", longer: "人の方が3割以上長い", other: "その他（型の網に当たらない）",
};
/**
 * 型 → 関係する設計知見の id（2026-10-16 scripts/kb.ts --q で引いて決めた・id の頭8字）。弱い所の候補に添える（費用0）。
 *   決めた事は報告と scripts/kb-daily-diff-1016.json に書く
 */
export const EDIT_TYPE_KB: Record<EditType, string[]> = {
  rewrite: ["97ea82f3", "a09c202a"], promise_escape: ["4363a9f6", "97ea82f3"], promise_added: ["4b744a33", "64697760"],
  vague_promise_cut: ["8537df84"], extra_cut: ["744c35dc"], appeal_cut: ["ce02cbef"], appeal_added: ["54d7ac86"],
  greeting_added: ["3696fe20"], greeting_cut: ["3696fe20"], name_line_added: ["3696fe20"], close_added: ["3696fe20"], close_cut: ["3696fe20"],
  residue: ["fd3ca6f4"], fact_fix: ["64697760"], shorter: ["744c35dc"], longer: ["a09c202a"], other: ["a09c202a"],
};
/** 箱ごとの設計知見（型の id に足す） */
export const BUCKET_KB: Record<MinedBucket, string[]> = { reply_edit: [], aix_text_edit: ["1a35e6d6", "ce349a3f"], aix_turn: ["4b744a33", "64697760"] };
/** 短いお礼・了承の番の書き直し（AI が前の約束・別の話題を足す）の知見 */
export const ACK_SCENE_KB = ["aca164df", "1ccdfdef"];

/** 大きく直した＝classifyEdit の量が large/rewrite（近さ 0.6 未満） */
export const BIG_AMOUNTS: ReadonlySet<EditAmount> = new Set(["large", "rewrite"]);

// 語の網（scripts/audit-draft-gap-types.ts と同じ線）
const N = (s: string) => s.normalize("NFKC");
export const CHECK_RE = /確認(?:させて|致し|いたし|して|し(?:ご連絡|次第|て)|出来次第)|お調べ|問い合わせ|問合せ/;
const VAGUE_CHECK_RE = /^(?:[^。！!]{0,10})?(?:確認出来次第|確認しご連絡|確認次第)/;
const GREET_RE = /お世話になっております|はじめまして/;
const NAME_LINE_RE = /^[^。！!\s]{1,14}(?:さん|様)[、,]?$/;
const CLOSE_RE = /よろしくお願い|何卒|お手隙|ご査収|ご確認(?:下さい|ください)|お気軽に|お申し付け/;
const EXTRA_RE = /見つかるまで|全力で|サポートさせて|尽力|最善の|ご安心|安心です|楽しみ|嬉しく思/;
const APPEAL_RE = /内覧|ご案内|お申込|申込|抑え|押さえ/;
const RESIDUE_RE = /\[AIX|【AIX|finalCheck|\*\*|FINAL_CHECK|現状の会話/;

/** 下書き（生成文）と実送信の差の型（重なる・決まった処理・費用0）。型の網に当たらなければ ["other"] */
export function editTypesOf(draft: string, sent: string): EditType[] {
  const d = String(draft ?? ""), s = String(sent ?? "");
  const e = classifyEdit(d, s);
  const { deleted, added } = editLines(d, s);
  const out: EditType[] = [];
  if (e.sim < 0.3) out.push("rewrite");
  if (s.trim() && CHECK_RE.test(N(d)) && !CHECK_RE.test(N(s))) out.push("promise_escape");
  if (!CHECK_RE.test(N(d)) && CHECK_RE.test(N(s))) out.push("promise_added");
  if (deleted.some((x) => VAGUE_CHECK_RE.test(N(x).trim()))) out.push("vague_promise_cut");
  if (deleted.some((x) => EXTRA_RE.test(x))) out.push("extra_cut");
  if (deleted.some((x) => APPEAL_RE.test(x)) && !APPEAL_RE.test(s)) out.push("appeal_cut");
  if (!APPEAL_RE.test(d) && APPEAL_RE.test(s)) out.push("appeal_added");
  if (!GREET_RE.test(d) && GREET_RE.test(s)) out.push("greeting_added");
  if (GREET_RE.test(d) && !GREET_RE.test(s)) out.push("greeting_cut");
  if (s.split(/\n/).some((x) => NAME_LINE_RE.test(x.trim())) && !d.split(/\n/).some((x) => NAME_LINE_RE.test(x.trim()))) out.push("name_line_added");
  if (!CLOSE_RE.test(d) && CLOSE_RE.test(s)) out.push("close_added");
  if (CLOSE_RE.test(d) && !CLOSE_RE.test(s)) out.push("close_cut");
  if (RESIDUE_RE.test(d)) out.push("residue");
  if (e.kinds.some((k) => k === "money" || k === "datetime" || k === "property")) out.push("fact_fix");
  const lg = e.kinds.includes("length");
  if (lg && s.length < d.length) out.push("shorter");
  if (lg && s.length > d.length) out.push("longer");
  if (added.length === 0 && deleted.length === 0 && !out.length) out.push("other");
  return out.length ? out : ["other"];
}
/**
 * スタッフが入れた値（金額・日時）: 実送信にあって、下書きにも番までの会話（ground）にも無い値の型。
 *   内覧日・見積の金額・入居可能日など人しか知らない値＝返信の外れでなく AIX の番に数える（竹内さん 10/16）。会話にある値を AI が落とした・違えた時は数えない（返信の外れ）
 */
export function staffValuesOf(draft: string, sent: string, ground: string): string[] {
  const d = factTokensOf(draft), s = factTokensOf(sent), g = factTokensOf(ground);
  const out: string[] = [];
  for (const k of ["money", "datetime"] as const) if ([...s[k]].some((v) => !d[k].has(v) && !g[k].has(v))) out.push(`staff_value:${k}`);
  return out;
}
const VALUE_ONLY_TYPES: ReadonlySet<EditType> = new Set(["fact_fix", "shorter", "longer", "other"]);

/** 型の網が「量」しか言えない（どう直されたかを LLM に聞く候補） */
export function needsLlmLabel(types: ReadonlyArray<EditType>): boolean {
  return types.every((t) => t === "rewrite" || t === "shorter" || t === "longer" || t === "other");
}

/** 会話 id の hash（外に出す物はこれだけ） */
export function convHash(id: string): string { return createHash("sha256").update(String(id)).digest("hex").slice(0, 12); }

export type MinedTurn = {
  source: MinedSource;
  bucket: MinedBucket;
  /** 会話 id（手元の試験の束にだけ使う・外に出す物は convHash） */
  conv: string;
  convHash: string;
  /** 番の最後のお客様の発言の時刻（試験の問題の at）。AIX の例では送った時刻 */
  at: string;
  scene: string;
  sceneJa: string;
  writer: string | null;
  amount: EditAmount;
  sim: number;
  types: EditType[];
  /** 人しか知らない事の型（staffFactsOf の kind・findStaffOnlyFact の kind・押した AIX） */
  humanKinds: string[];
  /** AIX の種類（AIX の例・押した AIX） */
  aix: string | null;
  /** 道の正解の符号（brain-exam-score の語彙）。試験の問題の accept */
  accept: string[];
  customer: string; draft: string; sent: string;
  /** LLM で足した直し方（DeepSeek・任意） */
  llmLabel?: { kind: string; note: string } | null;
};

export type ReplyTurnInput = {
  conv: string; at: string; scene: string; sceneJa: string; writer: string | null;
  customer: string; draft: string | null; sent: string;
  /** 返事のまとまりで押した AIX（押した順） */
  pressed: string[];
  /** 人しか知らない事（呼ぶ側が staffFactsOf / findStaffOnlyFact で出した物・下書きにも同じ型がある物は除いた物） */
  humanKinds: string[];
};
/** 返信の番 1つ → 拾う番（拾わなければ null）。下書きが無い・送った文が無い（AIX だけ）は、人しか知らない事・AIX を押した時だけ aix_turn */
export function mineReplyTurn(i: ReplyTurnInput): MinedTurn | null {
  const draft = String(i.draft ?? "").trim(), sent = String(i.sent ?? "").trim();
  if (!draft) return null;
  const base = { source: "reply" as const, conv: i.conv, convHash: convHash(i.conv), at: i.at, scene: i.scene, sceneJa: i.sceneJa, writer: i.writer, customer: i.customer, draft, sent };
  if (i.pressed.length || i.humanKinds.length) {
    const e = sent ? classifyEdit(draft, sent) : { amount: "rewrite" as EditAmount, sim: 0 };
    if (!i.pressed.length && !BIG_AMOUNTS.has(e.amount)) return null;
    const kinds = [...i.pressed.map((p) => `AIX:${p}`), ...i.humanKinds];
    const accept = i.pressed.length ? [`AIX:${i.pressed[0]}`] : [...new Set(i.humanKinds.map(aixCodeOfHumanKind))];
    return { ...base, bucket: "aix_turn", amount: e.amount, sim: round2(e.sim), types: sent ? editTypesOf(draft, sent) : ["rewrite"], humanKinds: kinds, aix: i.pressed[0] ?? null, accept };
  }
  if (!sent) return null;
  const e = classifyEdit(draft, sent);
  if (!BIG_AMOUNTS.has(e.amount)) return null;
  const types = editTypesOf(draft, sent);
  const accept = CHECK_RE.test(N(sent)) ? ["2段:check", "2段"] : ["返信"];
  return { ...base, bucket: "reply_edit", amount: e.amount, sim: round2(e.sim), types, humanKinds: [], aix: null, accept };
}

export type AixExampleInput = { conv: string; at: string; aixAction: string; writer: string | null; customer: string; draft: string; sent: string; sceneJa?: string; ground?: string };
/** AIX の生成文と実送信の組 1つ → 拾う番。スタッフが値（金額・日時）を入れただけの直しは文の外れに数えず aix_turn（人が値を入れた） */
export function mineAixExample(i: AixExampleInput): MinedTurn | null {
  const draft = String(i.draft ?? "").trim(), sent = String(i.sent ?? "").trim();
  if (!draft || !sent) return null;
  const e = classifyEdit(draft, sent);
  if (!BIG_AMOUNTS.has(e.amount)) return null;
  const types = editTypesOf(draft, sent);
  const values = staffValuesOf(draft, sent, i.ground ?? i.customer);
  const valueOnly = values.length > 0 && types.includes("fact_fix") && types.every((t) => VALUE_ONLY_TYPES.has(t));
  return {
    source: "aix", bucket: valueOnly ? "aix_turn" : "aix_text_edit", conv: i.conv, convHash: convHash(i.conv), at: i.at, scene: i.aixAction, sceneJa: i.sceneJa ?? `AIX:${i.aixAction}`,
    writer: i.writer, amount: e.amount, sim: round2(e.sim), types, humanKinds: valueOnly ? values : [], aix: i.aixAction, accept: [`AIX:${i.aixAction}`], customer: i.customer, draft, sent,
  };
}

/** 人しか知らない事の型 → 道の符号（AIX の族） */
export function aixCodeOfHumanKind(k: string): string {
  if (/^AIX:/.test(k)) return k;
  if (k === "viewing_slot" || k === "viewing_fixed") return "AIX:viewing_invite";
  if (k === "meeting_time" || k === "meeting_address") return "AIX:meeting_place";
  if (k === "estimate_amount") return "AIX:estimate_send";
  return "AIX:property_check_result";
}
const round2 = (x: number) => Math.round(x * 100) / 100;

export type WeakSpot = {
  key: string; bucket: MinedBucket; scene: string; type: EditType;
  n: number; takeuchi: number; employee: number;
  /** 関係する設計知見の id（型・箱・場面から） */
  kb: string[];
  /** 代表の番（会話の hash・時刻）。文は呼ぶ側が伏せて足す */
  examples: Array<{ convHash: string; at: string; sim: number }>;
};
/** 拾った番 → 弱い所の候補（箱×場面×型ごとの数・竹内さんの番を重く・数の多い順） */
export function weakSpotsOf(turns: ReadonlyArray<MinedTurn>, opts: { examples?: number } = {}): WeakSpot[] {
  const m = new Map<string, WeakSpot>();
  for (const t of turns) {
    // AIX の番は型（文の直し方）でなく、人しか知らない事の型で束ねる（type は other）
    const list: EditType[] = t.bucket === "aix_turn" ? ["other"] : t.types;
    for (const ty of list) {
      const key = `${t.bucket}|${t.sceneJa}|${t.bucket === "aix_turn" ? (t.humanKinds[0] ?? "") : ty}`;
      const w = m.get(key) ?? {
        key, bucket: t.bucket, scene: t.sceneJa, type: ty, n: 0, takeuchi: 0, employee: 0,
        kb: [...new Set([...(t.bucket === "aix_turn" ? [] : EDIT_TYPE_KB[ty]), ...BUCKET_KB[t.bucket], ...(t.scene === "ack" ? ACK_SCENE_KB : [])])],
        examples: [],
      };
      w.n++;
      if (t.writer === "takeuchi") w.takeuchi++; else if (t.writer === "employee") w.employee++;
      if (w.examples.length < (opts.examples ?? 3)) w.examples.push({ convHash: t.convHash, at: t.at, sim: t.sim });
      m.set(key, w);
    }
  }
  return [...m.values()].sort((a, b) => (b.takeuchi * 2 + b.n) - (a.takeuchi * 2 + a.n));
}

/** brain-exam-add の --add-batch に渡す形（ExamSpec の id なし）。scripts 側の型に依存しない最小の形 */
export type ExamSpecCandidate = {
  type: string; tags: string[]; source: string; conv: string; at: string; accept: string[]; mustNot: string[];
  asks: Array<{ q: string; route: "reply" | "promise" | "aix" | "none"; point: string }>; ng: string[]; why: string; stage: "brain" | "draft"; addedBy: string;
};
const NG_OF: Partial<Record<EditType, string>> = {
  promise_escape: "答えられる事を確認の約束にする", extra_cut: "伴走・安心の余計な一文を足す", vague_promise_cut: "対象のない「確認出来次第ご連絡」を足す",
  appeal_cut: "頼まれていない内覧・申込の誘いを足す", residue: "作業メモ・記号を残す", fact_fix: "会話に無い金額・日時・物件を書く",
};
/**
 * 拾った番 → 試験の問題の候補（竹内さんの番・返信の番の reply_edit／aix_turn だけ）。文は呼ぶ側が2重に伏せた物を渡す（mask）。
 *   正解の道（accept）は実送信から（手打ち＝返信／確認の約束＝2段:check／AIX を押した・人しか知らない事＝AIX）。正解の文は brain-exam-add の buildProblem が実送信から作る（staffText）
 */
export function examSpecOf(t: MinedTurn, mask: (s: string) => string): ExamSpecCandidate | null {
  if (t.writer !== "takeuchi" || t.source !== "reply") return null;
  if (!t.accept.length) return null;
  const route: "reply" | "promise" | "aix" = t.bucket === "aix_turn" ? "aix" : t.accept[0].startsWith("2段") ? "promise" : "reply";
  const isEscape = t.types.includes("promise_escape") && route === "reply";
  const type = t.bucket === "aix_turn" ? "返信かAIXか" : isEscape ? "一般的な事を保留しない" : "直された番";
  const stage: "brain" | "draft" = t.bucket === "aix_turn" || isEscape || route === "promise" ? "brain" : "draft";
  const typesJa = t.bucket === "aix_turn" ? t.humanKinds.join("・") : t.types.map((x) => EDIT_TYPE_JA[x].replace(/（.*$/, "")).join("・");
  const q = [...mask(t.customer).replace(/\s+/g, " ").trim()].slice(0, 120).join("");
  const point = [...mask(t.sent).replace(/\s+/g, " ").trim()].slice(0, 200).join("");
  if (!q || !point) return null;
  return {
    type, tags: ["直された番", t.sceneJa, ...(t.bucket === "aix_turn" ? ["AIX の番"] : t.types.slice(0, 3).map((x) => EDIT_TYPE_JA[x].replace(/（.*$/, "")))],
    source: `直された番の拾い出し（edited-turn-miner・${t.at.slice(0, 10)}・近さ ${t.sim}）`,
    conv: t.conv, at: t.at, accept: t.accept,
    mustNot: isEscape ? ["2段"] : t.bucket === "aix_turn" ? ["返信"] : [],
    asks: [{ q, route, point }],
    ng: t.bucket === "aix_turn" ? ["人しか知らない事（確認の結果・空き・日時・金額）を返信の文で言い切る"] : t.types.map((x) => NG_OF[x]).filter((x): x is string => !!x),
    why: `下書きを大きく直して送った番（${BUCKET_JA[t.bucket]}・近さ ${t.sim}・${typesJa}）。正解は竹内さんの実送信`,
    stage, addedBy: "edited-turn-miner",
  };
}

/** 見張りを回すか（既定 on・EDITED_TURN_MINER=off で止める） */
export function editedTurnMinerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.EDITED_TURN_MINER ?? "on").trim().toLowerCase() !== "off";
}

/** 数のまとめ（cron_run_logs に残す形・文を持たない＝個人情報なし） */
export function compactMined(turns: ReadonlyArray<MinedTurn>, pairs: { reply: number; aix: number }, top = 15): Record<string, unknown> {
  const byBucket: Record<string, number> = {}, byType: Record<string, number> = {}, byScene: Record<string, number> = {};
  for (const t of turns) {
    byBucket[t.bucket] = (byBucket[t.bucket] ?? 0) + 1;
    byScene[t.sceneJa] = (byScene[t.sceneJa] ?? 0) + 1;
    if (t.bucket !== "aix_turn") for (const ty of t.types) byType[ty] = (byType[ty] ?? 0) + 1;
  }
  return {
    pairs, picked: turns.length, takeuchi: turns.filter((t) => t.writer === "takeuchi").length, byBucket, byType, byScene,
    weakSpots: weakSpotsOf(turns).slice(0, top).map((w) => ({ bucket: w.bucket, scene: w.scene, type: w.type, n: w.n, takeuchi: w.takeuchi, kb: w.kb, ex: w.examples.map((e) => `${e.convHash.slice(0, 8)}@${e.at.slice(5, 16)}`) })),
  };
}
