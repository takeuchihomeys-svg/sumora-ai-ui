// app/lib/shadow-auto-gate.ts
// 影の関所（LINE の見張り 3段目）— 番ごとに「自動で送っていたら、この文を送ったか／どの線で止めたか」を記録するだけ（純関数・DB も LLM も持たない）。
//
// 2026-11-11 作業員6（統括役の E1）: line_watch_turns.auto_eligible は 10/01 の1段目で列だけ作られ、3段目（書き手）が作られないまま
//   全期間 0行だった（「自動で送っていたら当たっていたか」を測れない）。毎晩の 2段目（line-watch-eval-server.evaluateLineWatchTurns）が
//   番を判定する時に、この関数で同じ番の関所を当てて auto_eligible に書く。
//
// 【安全の決まり（最重要・設計知見 ddd883fb）】
//   ・送信の経路には一切つながない。ここは記録だけ（scheduled_messages・conversations・LINE には書かない）。
//   ・本物の関所 canAutoReply（auto-reply-policy.ts）を「この会話が自動だったら」の仮定（auto_send_enabled=true・予約なし）で呼ぶだけ。
//     関所の線を2つ作らない（四者同名）。auto_send_enabled の値・送信の関数は触らない。
//   ・材料が足りない時は止める側に倒す（fail-closed）。記録には足りなかった材料（missing）を残す＝影が本物より甘く見えないように。
//   ・判断はすべてブレイン基準（P0 9eb6aa9c）。ここは安全の線と記録だけ（ブレインの AIX の判断を変えない）。
import { canAutoReply } from "./auto-reply-policy";
import { aixAutoSendGate } from "./staff-confirm-facts";
import { hasOutgoingResidue } from "./outgoing-residue";
import { APPLICATION_FORMAT_RE } from "./apply-sub-mode";
import { draftToSendableText } from "./draft-text";
import { confidenceFromCheck, draftConfidenceEnabled } from "./draft-confidence";
import { staffCheckOf } from "./conductor-staff-check";

export const SHADOW_GATE_VERSION = "sg-2026-11-11";

/** 戻す: SHADOW_AUTO_GATE=off（記録しない）。記録だけのスイッチ＝既定 on（KB e805f15e） */
export function shadowAutoGateEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SHADOW_AUTO_GATE ?? "").trim().toLowerCase() !== "off";
}

/**
 * 最終チェックに block があるか。auto-reply-dispatch の hasBlock と同じ読み（送信の経路のファイルは触らないので写した・形を変えたら両方直す）
 */
export function finalCheckHasBlock(check: unknown): boolean {
  if (!check || typeof check !== "object") return false;
  const c = check as Record<string, unknown>;
  if (c.ok === false) return true;
  const items = Array.isArray(c.issues) ? c.issues : Array.isArray(c.items) ? c.items : [];
  return items.some((it) => {
    if (!it || typeof it !== "object") return false;
    const sev = (it as Record<string, unknown>).severity;
    return sev === "block" || sev === "error";
  });
}

export type ShadowGateInput = {
  /** 判定に使った下書き（pickJudgeDraft の draft） */
  draft: string | null | undefined;
  /** その下書きの出所（pickJudgeDraft の src）。stale＝この番のために作られた下書きではない */
  draftSrc: "last" | "first" | "stale" | "none" | string | null | undefined;
  /** 下書きの合図（[AIX誘導中] 等。控えの draft_sentinel） */
  sentinel?: string | null;
  /** 合図の時刻（draft_sentinel_at）と下書きの時刻（draft_last_at か draft_first_at） */
  sentinelAt?: string | null;
  draftAt?: string | null;
  convStatus: string | null | undefined;
  /** 番の時点で申込以降か（見張りの postApplyAtTurn） */
  postApply?: boolean;
  brainReplyMode: string | null | undefined;
  brainAction: string | null | undefined;
  /** 控えの final_check（ai_draft_check の形。confidence も入る） */
  finalCheck: unknown;
  /** 金額・日付・号室の根拠（番の最後のお客様の発言までの会話＋登録の家賃＋本文の外の材料）。null は「読めなかった」 */
  groundText: string | null | undefined;
  /** 本文の外の材料（送った資料・AIX の記録・内覧の予定）を足せたか */
  groundExtra?: boolean;
  /** お礼・了承の番で読むべき範囲の外の行為（見張りの outOfTopicActs の結果） */
  outOfTopicActs?: ReadonlyArray<string> | null;
  /** 下書きがスタッフの最初の返事より前にできていたか（見張りの draft_ready_before_staff）。null＝分からない */
  draftReadyBeforeStaff?: boolean | null;
  env?: Record<string, string | undefined>;
};

export type ShadowGate = {
  v: string;
  /** 自動で送っていたか（この会話が自動だった仮定） */
  would_send: boolean;
  /** 止めた最初の線（canAutoReply の理由・または影で足した線）。送る時は "ok" */
  reason: string;
  /** 止めた線の全部（最初の線＋予約の前の網・影で足した線） */
  lines: string[];
  /** 送っていた文（画面と同じ整形の後・2,000字まで）。止めた時も「送るならこの文」として残す */
  text: string | null;
  /** ブレインが AIX を指した時の AIX の関所（スタッフの確認が要る AIX は送らない） */
  aix: { action: string; ok: boolean; reason: string } | null;
  /** 自信（generate-reply が載せた draft-confidence） */
  confidence: { score: number; band: string } | null;
  /** 影が本物の関所に渡せなかった材料（2段の種類・予算の目安の文 等）。あれば本物の関所より甘い恐れ＝解禁の数には入れない */
  missing: string[];
  draft_src: string | null;
  ready_before_staff: boolean | null;
};

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");

/**
 * 番1つの影の関所。canAutoReply（本物の関所）＋予約に積む前の網（auto-reply-dispatch の名残・申込フォーマット・読むべき範囲）＋影で足す線。
 *   影で足す線（本物の関所には無い・fail-closed）: post_apply（番の時点で申込以降）・draft_not_for_turn（この番の下書きではない）・ground_unread（根拠を読めなかった）
 */
export function shadowAutoGate(i: ShadowGateInput): ShadowGate {
  const env = i.env ?? (typeof process !== "undefined" ? process.env : {});
  const sendable = draftToSendableText(i.draft ?? null);
  const text = sendable && sendable.trim() ? cut(sendable.trim(), 2000) : null;
  const action = (i.brainAction ?? "").trim();
  const conf = confidenceFromCheck(i.finalCheck);
  const lines: string[] = [];
  const missing: string[] = ["two_stage_kind", "rent_budget_sentence"]; // 控えに無い（suggested_aix_meta の中）→ 本物の関所の ⑥-4・⑥-8 は当てられない

  if (i.postApply) lines.push("post_apply");
  if (i.draftSrc === "stale") lines.push("draft_not_for_turn");
  if (i.groundText == null) lines.push("ground_unread");
  // 2026-11-11 下書きがあるのに最終チェックの控えが無い番（28日で返信の番 21）。本物の関所は block が無い＝通すが、影は止める側に倒す
  //   （本物の関所の穴として brain_weaknesses に入れた。送信の経路は触らない）
  if (text && (i.finalCheck == null || typeof i.finalCheck !== "object")) lines.push("no_final_check");
  else if (!i.groundExtra) missing.push("ground_extra");
  // 下書きの合図（[AIX誘導中]・[返信不要]）は控えでは draft_sentinel に分かれている。下書き欄の最後の状態が合図だった時だけ
  //   （合図の時刻が下書き以後・時刻が分からなければ合図を効かせる＝止める側）本文の先頭に戻して本物の関所の sentinel_draft に当てる
  const sa = i.sentinelAt ? Date.parse(i.sentinelAt) : NaN, da = i.draftAt ? Date.parse(i.draftAt) : NaN;
  const sentinelActive = !!i.sentinel && (!text || !Number.isFinite(sa) || !Number.isFinite(da) || sa >= da);
  const draftForGate = sentinelActive ? (text ? `${i.sentinel}\n${text}` : i.sentinel!) : text;

  const v = canAutoReply({
    autoSendEnabled: true, // 影の仮定: この会話が自動だったら（本物の auto_send_enabled は読まない・書かない）
    lastSender: "customer",
    replyMode: i.brainReplyMode ?? null,
    suggestedAixAction: action || null,
    draft: draftForGate,
    draftHasBlock: finalCheckHasBlock(i.finalCheck),
    draftConfidenceLow: draftConfidenceEnabled(env) && conf?.band === "low",
    status: i.convStatus ?? null,
    hasPendingScheduled: false,
    groundText: i.groundText ?? "",
    twoStageKind: null,
    rentBudgetSentence: null,
  });
  if (!v.ok) lines.push(v.reason);
  // 2026-11-13 作業員5（conductor-staff-check）: 統括が人に回した番は、その理由（ref_unresolved 等）を止めた線に入れる（影だけ・本物の送信の経路は触らない）。
  //   控えに staff_check が無い番（CONDUCTOR_STAFF_CHECK=off の時）は何も足さない
  const sc = staffCheckOf(i.finalCheck);
  if (sc) lines.push(...sc.reasons);
  // 予約に積む前の網（auto-reply-dispatch と同じ順・同じ関数）
  if (text && hasOutgoingResidue(text)) lines.push("outgoing_residue");
  if (text && APPLICATION_FORMAT_RE.test(text)) lines.push("application_format_in_draft");
  if ((env.ACK_TOPIC_SCOPE ?? "") !== "off" && (i.outOfTopicActs?.length ?? 0) > 0) lines.push("ack_topic_out_of_scope");

  const uniq = [...new Set(lines)];
  return {
    v: SHADOW_GATE_VERSION,
    would_send: uniq.length === 0,
    reason: uniq[0] ?? "ok",
    lines: uniq,
    text,
    aix: action ? { action, ...aixAutoSendGate(action) } : null,
    confidence: conf ? { score: conf.score, band: conf.band } : null,
    missing,
    draft_src: i.draftSrc ?? null,
    ready_before_staff: i.draftReadyBeforeStaff ?? null,
  };
}

/**
 * 影の関所の根拠の文（auto-reply-dispatch の groundText と同じ形: 直近の通＋登録の家賃）。
 *   番の最後のお客様の発言までの通だけ（番の後のスタッフの返事は根拠にしない＝後から分かった事で甘くしない）。
 *   本文の外の材料（送った資料・AIX の記録）は今の状態しか読めない（番より後の物が混ざる）ので足さない＝止める側（missing に ground_extra）
 */
export function watchGroundText(
  msgs: ReadonlyArray<{ created_at: string; text?: string | null }>,
  customerLastAt: string,
  rents?: { rent_min?: number | null; rent_max?: number | null; initial_cost_limit?: number | null } | null,
  maxMsgs = 40,
): string {
  const until = Date.parse(customerLastAt);
  const upto = msgs.filter((m) => Date.parse(m.created_at) <= until + 1000).slice(-maxMsgs);
  const rent = rents ? [rents.rent_min, rents.rent_max, rents.initial_cost_limit].filter(Boolean).map((v) => `${v}円`).join(" ") : "";
  return `${upto.map((m) => m.text ?? "").join("\n")}\n${rent}`;
}
