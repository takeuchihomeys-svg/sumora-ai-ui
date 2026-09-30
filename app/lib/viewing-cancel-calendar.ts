// app/lib/viewing-cancel-calendar.ts
// お客様が「決まった内覧」を取りやめた時に、カレンダーのどの予定を消すかを決める（純関数・DB 依存なし）。
//
// 2026-09-30 竹内さん（内覧の枠の決まりの続き・「その提案通り」）: お客様からの取りやめで、こちらのカレンダーの決まった内覧を自動で消す
//   （申込ツールのカレンダーの行も同じ鍵で消す）。旧は人がカレンダーで消すまで残り、空き時間の計算でその時間が埋まったままだった。
//
// 誤って消さない線:
//   ① 取りやめと読んだのが「今回のお客様の連投」の時だけ
//      ＝連投の前は 確定（confirmed）・連投の後は none／customer_cancelled_after_confirm（内覧の流れ viewing-flow.ts の1関数の値）。
//      過去の発言の取りやめで後から消さない（その後に新しく決まった内覧を消さない）
//   ② 消すのはその会話に結び付いた・今日以降の・済みでない・決まった内覧の予定だけ
//      （時間確保【時間確保】・ブレインの未確定の予定・【必ず】の約束・他のお客様の予定・済みの予定は触らない）
//   ③ 別の日への変更（change_after_confirm 系）は消さない（人が直す）。viewing-flow が取りやめにしないので①で外れる
//   ④ 決まっていた日と同じ日の予定が1件に決まる時だけ（2件以上で時刻でも決まらない・日が合わない時は消さずに記録だけ）
import type { ViewingFlow } from "./viewing-flow";
import { isOutingViewingNotes } from "./viewing-slot-plan";
import { jstParts } from "./jst-date";
import { buildActionLedger, type LedgerInput } from "./action-ledger";

/** 止める環境変数（VIEWING_CANCEL_AUTO=off で消さない） */
export function viewingCancelAutoEnabled(env: string | null | undefined = process.env.VIEWING_CANCEL_AUTO): boolean {
  return (env ?? "").trim().toLowerCase() !== "off";
}

export type CancelDecision =
  | { cancel: true; day: string | null; time: string | null }
  | { cancel: false; why: "last_not_customer" | "not_cancel" | "not_confirmed_before" };

/**
 * 今回のお客様の連投で、決まっていた内覧が取りやめになったか。
 *   before … 今回の連投より前までの内覧の流れ／after … 今回の連投まで入れた内覧の流れ
 */
export function decideViewingCancel(o: { before: ViewingFlow | null | undefined; after: ViewingFlow | null | undefined; lastSender: string | null | undefined }): CancelDecision {
  if (o.lastSender !== "customer") return { cancel: false, why: "last_not_customer" };
  const a = o.after;
  if (!a || a.stage !== "none" || a.reason !== "customer_cancelled_after_confirm") return { cancel: false, why: "not_cancel" };
  const b = o.before;
  if (!b || b.stage !== "confirmed") return { cancel: false, why: "not_confirmed_before" };
  const [day, time] = (b.label ?? "").split(" ");
  return { cancel: true, day: /^\d{1,2}\/\d{1,2}$/.test(day ?? "") ? day : null, time: /^\d{1,2}:\d{2}$/.test(time ?? "") ? time : null };
}

export type CalEventRow = {
  id: number | string; conversation_id: string | null; event_type: string | null; start_at: string; end_at?: string | null;
  all_day?: boolean | null; notes: string | null; is_done?: boolean | null; title?: string | null; customer_name?: string | null;
};
export type CancelPick = { deleteIds: Array<number | string>; candidates: Array<number | string>; why: "picked" | "no_candidate" | "day_mismatch" | "ambiguous" };

const mdOf = (iso: string) => { const p = jstParts(iso); return `${p.m}/${p.d}`; };
const hmOf = (iso: string) => { const p = jstParts(iso); return `${p.hour}:${String(p.minute).padStart(2, "0")}`; };
const ymdNum = (p: { y: number; m: number; d: number }) => p.y * 10000 + p.m * 100 + p.d;

/** 消してよい種類の予定か（その会話の・今日以降の・済みでない・決まった内覧） */
export function isCancellableViewingEvent(e: CalEventRow, conversationId: string, nowMs: number): boolean {
  if (!conversationId || e.conversation_id !== conversationId) return false;
  if (e.is_done) return false;
  if (!isOutingViewingNotes(e.event_type, e.notes)) return false;   // 時間確保・未確定・【必ず】連絡・内覧以外は違う
  if (/^\s*【必ず】/.test(e.notes ?? "")) return false;
  return ymdNum(jstParts(e.start_at)) >= ymdNum(jstParts(nowMs));
}

/**
 * 消す予定を選ぶ。決まっていた日（M/D）の予定が1件ならそれ。同じ日に2件以上なら時刻が合う1件。
 * 決まっていた日が分からない時は、候補が1件だけの時にその1件。決まらない時は消さない
 */
export function pickViewingEventsToCancel(o: { events: ReadonlyArray<CalEventRow>; conversationId: string; day: string | null; time: string | null; nowMs: number }): CancelPick {
  const cands = o.events.filter((e) => isCancellableViewingEvent(e, o.conversationId, o.nowMs));
  const ids = cands.map((e) => e.id);
  if (cands.length === 0) return { deleteIds: [], candidates: ids, why: "no_candidate" };
  if (!o.day) return cands.length === 1 ? { deleteIds: [cands[0].id], candidates: ids, why: "picked" } : { deleteIds: [], candidates: ids, why: "ambiguous" };
  const sameDay = cands.filter((e) => mdOf(e.start_at) === o.day);
  if (sameDay.length === 0) return { deleteIds: [], candidates: ids, why: "day_mismatch" };
  if (sameDay.length === 1) return { deleteIds: [sameDay[0].id], candidates: ids, why: "picked" };
  const t = o.time ? o.time.replace(/^0/, "") : null;
  const sameTime = t ? sameDay.filter((e) => !e.all_day && hmOf(e.start_at) === t) : [];
  return sameTime.length === 1 ? { deleteIds: [sameTime[0].id], candidates: ids, why: "picked" } : { deleteIds: [], candidates: ids, why: "ambiguous" };
}

/**
 * 連投の中に「内覧の取りやめのお願い」と読める行があるか（予定を消す出口だけの線。内覧の流れの段階の判定は変えない）。
 * 監査（180日）の実物 ae321772「では現状抑えていただいてる分については一度キャンセルになりますか？💦」は、申込で押さえた部屋の話＋キャンセルになるかの質問で、
 *   内覧の取りやめではない。取りやめの語の行が、内覧の語を持たず、申込・審査・押さえ・契約・番手の話か「キャンセルになりますか／できますか／料」の質問の形なら数えない。
 *   「すいません💦内覧キャンセルでも大丈夫ですか😂」（110b3053）は内覧の語があるのでお願いとして数える
 */
const CANCEL_WORD_RE = /キャンセル|中止|延期|行けなく|(?:内覧|内見|見学)[^\n]{0,8}(?:やめ|辞め|見送)/;
const VIEWING_WORD_RE = /内覧|内見|見学|ご案内/;
const NOT_VIEWING_TOPIC_RE = /申し?込|審査|抑え|押さえ|おさえ|契約|番手|引っ?越し業者|キャンセル(?:料|に?なり|でき|可能|不可|した(?:ら|場合)|して(?:も|しまう))/;
export function hasViewingCancelRequestLine(turnText: string | null | undefined): boolean {
  return String(turnText ?? "").normalize("NFKC").split(/\n+/).some((line) => CANCEL_WORD_RE.test(line) && (VIEWING_WORD_RE.test(line) || !NOT_VIEWING_TOPIC_RE.test(line)));
}

/** 履歴（古い順）から今回のお客様の連投の始まりの位置（最後がお客様でなければ -1） */
export function currentCustomerTurnStart(messages: ReadonlyArray<{ sender: string }>): number {
  let i = messages.length - 1;
  if (i < 0 || messages[i].sender !== "customer") return -1;
  while (i - 1 >= 0 && messages[i - 1].sender === "customer") i--;
  return i;
}

/**
 * 台帳の入力（ブレインが台帳を作る時と同じ・messages は古い順）から、今回の連投での取りやめを決める。
 * 連投の前の流れは「連投の最初の発言の時刻」を今として解く（その時点で確定だったか）。本番・監査・テストが同じ関数を通る
 */
export function decideViewingCancelFromLedgerInput(input: LedgerInput, nowMs: number = input.now ?? Date.now()): CancelDecision & { triggerText: string; triggerAt: string | null } {
  const msgs = input.messages ?? [];
  const start = currentCustomerTurnStart(msgs);
  const none = (why: "last_not_customer" | "not_cancel" | "not_confirmed_before") => ({ cancel: false as const, why, triggerText: "", triggerAt: null });
  if (start < 0) return none("last_not_customer");
  const after = buildActionLedger({ ...input, now: nowMs }).facts.viewingFlow;
  if (!after || after.reason !== "customer_cancelled_after_confirm") return none("not_cancel");
  const turnAt = Date.parse(msgs[start].createdAt ?? "");
  const beforeMsgs = msgs.slice(0, start);
  const before = buildActionLedger({
    ...input, messages: beforeMsgs,
    lastCustomerAt: [...beforeMsgs].reverse().find((m) => m.sender === "customer")?.createdAt ?? null,
    now: Number.isFinite(turnAt) ? turnAt : nowMs,
  }).facts.viewingFlow;
  const triggerTextAll = msgs.slice(start).map((m) => m.text ?? "").join("\n");
  const d0 = decideViewingCancel({ before, after, lastSender: msgs[msgs.length - 1]?.sender });
  // 出口（予定を消す）は厳しく: 連投の中に「内覧の取りやめのお願い」と読める行がある時だけ
  const d: CancelDecision = d0.cancel && !hasViewingCancelRequestLine(triggerTextAll) ? { cancel: false, why: "not_cancel" } : d0;
  return { ...d, triggerText: triggerTextAll.slice(0, 500), triggerAt: msgs[msgs.length - 1]?.createdAt ?? null };
}
