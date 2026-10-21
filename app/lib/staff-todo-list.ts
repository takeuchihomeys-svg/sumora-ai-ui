// app/lib/staff-todo-list.ts — スタッフのグループに出す【やることリスト】を組み立てる（純関数・DB も fetch も LLM も持たない）
//
// 2026-10-20 竹内さん（設計知見 1d7ac7f4・72d92e4f）「LINE グループにやることリストを共有するようにする。【やることリスト】と入れて、
//   下にお客さんのアカウント名・AIX の種類・やるべき事を具体的に入れていく。お客さん毎に箇条書きで優先度の高い順に入れていく。
//   完了したと確認が取れたら✅を付けていく。…完了していなければ（●日）と経過の日付を入れておく」
//   ＝つなぎのブレイン（管理者）がスタッフに出す指示。段1はここ（読むだけの組み立て）＋見本（scripts/preview-staff-todo.ts）だけ。送らない。
//
// 材料（今ある物を1か所に寄せる・新しく判断しない）:
//   ① AIX 要対応（aix_action_items）… ブレインの依頼・約束の続き（promise_queue）・内覧当日の朝の挨拶。済み＝AIX の送信／返信の本文で済ませた（done_by）
//   ② お客様への約束（calendar_events の【必ず】）… ピックアップ・御見積書・確認→ご連絡・連絡の日。済み＝履行の送信（sent_facts の done を
//      promise-calendar.planPromiseCompletion で照らす＝カレンダーを閉じるのと同じ判定）。待ちの約束（新着待ち 等・連絡の日がまだ先）は今日のやる事にしない
//   ③ 今日の内覧（viewing_history）… 済み＝内覧済み・内覧の記録
//   ④ まだ返していないお客様の発言（messages）… 48時間以内・30分以上返していない・お礼や了承だけでない・AIX 要対応が立っていない
// 優先度（1d7ac7f4「お客様に約束した期日が近い・経過が長い・申込に近い順」）: 期限を過ぎた日数 → 経過日数 → 申込までの地図（apply-route-map）の近さ
// テスト: app/lib/__tests__/staff-todo-list.test.ts
import { aixButtonText } from "./aix-action-text";
import { AIX_BUTTON_LABELS } from "./aix-taxonomy";
import { MAIN_ROUTE, ROUTE_NODES, type RouteNodeId } from "./apply-route-map";
import { STATUS_STAGE_RANK, DRAFT_SKIP_STATUSES } from "./conversation-status";
import { jstDayStartMs, jstMDHm, JST_OFFSET_MS } from "./jst-date";
import { LINE_ACCOUNT_LABELS, normalizeLineAccountKey } from "./line-accounts";
import { planPromiseCompletion, promiseAixActionOf, promiseCheckPatternOf, PROMISE_MUST_MARK, TODAY_MARK } from "./promise-calendar";
import { isWaitPromiseNotes } from "./promise-timing";
import { isTestConversation } from "./test-conversations";
import { MORNING_GREETING_NOTE_PREFIX } from "./viewing-day-greeting";
import { PROMISE_QUEUE_NOTE_PREFIX } from "./promise-queue";
import type { LedgerKind } from "./action-ledger";

const DAY = 86_400_000;

/**
 * 切替（2026-10-21 竹内さんの決定 f87ccb7e で既定 on）。on の間は staff-todo-list の cron が2時間ごとにグループへ送り、
 * 被っていた AIX要対応リスト（announce-aix-actions）と朝の報告の約束・AIX要対応・未返信の節は出さない。
 * 戻す: STAFF_TODO_LIST=off（AIX要対応リストと朝の報告の節が元どおり出る）。組み立て・見本は off でも動く
 */
export function staffTodoListEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.STAFF_TODO_LIST ?? "").trim().toLowerCase() !== "off";
}

/**
 * AIX要対応の1件ずつの即時通知（ブレインが立てた時・内覧当日の朝の挨拶・約束の続き）をグループに送るか。
 * 2026-10-21 竹内さん「やることリストが on の間は1件ずつの通知は止めて一覧に入れる」→ STAFF_TODO_LIST が on の間は送らない。
 * 戻す: STAFF_TODO_INSTANT_NOTICE=on（一覧と併用）／STAFF_TODO_LIST=off（一覧ごと元に戻る）
 */
export function aixInstantNoticeEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  if (!staffTodoListEnabled(env)) return true;
  return (env.STAFF_TODO_INSTANT_NOTICE ?? "").trim().toLowerCase() === "on";
}

// ─── 入力（DB の行のまま・読み手は staff-todo-list-server.ts） ─────────────────────────
export type TodoConversation = {
  id: string; customer_name: string | null; account: string | null; status: string | null; is_post_apply?: boolean | null;
};
export type TodoAixItemRow = {
  id: string; conversation_id: string; customer_name: string | null; action: string; check_pattern: string | null;
  status: "pending" | "done" | "dismissed"; created_at: string; updated_at?: string | null;
  done_at: string | null; done_aix_type: string | null; done_by?: string | null; resolution_note?: string | null;
};
export type TodoPromiseRow = {
  id: number; conversation_id: string | null; customer_name: string | null; event_type: string | null;
  start_at: string; created_at: string; notes: string | null; is_done: boolean | null;
};
export type TodoFactRow = { conversation_id: string; kind: string; sent_at: string; detail?: { object?: string | null; checkPattern?: string | null } | null };
export type TodoViewingRow = {
  id: string | number; conversation_id: string | null; scheduled_date: string | null; scheduled_time: string | null;
  status: string | null; property_name: string | null; actual_date?: string | null; viewing_report_at?: string | null;
};
export type TodoMessageRow = { conversation_id: string; sender: string; text: string | null; created_at: string };
/** スタッフのグループの✅（staff_todo_marks・表がまだ無い間は空） */
export type TodoMarkRow = { item_key: string; conversation_id: string | null; marked_at: string };
/** お客様の発言の時刻だけ（約束の後にお客様が返したか＝条件待ちの約束の見分け） */
export type TodoCustomerTurnRow = { conversation_id: string; created_at: string };

export type TodoInput = {
  atMs: number;
  conversations: ReadonlyArray<TodoConversation>;
  aixItems: ReadonlyArray<TodoAixItemRow>;
  promises: ReadonlyArray<TodoPromiseRow>;
  /** 履行の送信（sent_facts の done）。AIX 要対応・約束のある会話の分 */
  facts: ReadonlyArray<TodoFactRow>;
  viewings: ReadonlyArray<TodoViewingRow>;
  messages: ReadonlyArray<TodoMessageRow>;
  marks?: ReadonlyArray<TodoMarkRow>;
  /** 約束のある会話のお客様の発言（時刻だけ）。無ければ条件待ちの見分けをしない */
  customerTurns?: ReadonlyArray<TodoCustomerTurnRow>;
};

// ─── 出力 ─────────────────────────────────────────────────────────────
export type TodoSource = "aix_item" | "promise" | "viewing" | "unanswered";
export type TodoItem = {
  key: string;
  conversationId: string;
  source: TodoSource;
  /** AIX のボタン（無ければ null＝返信・内覧） */
  action: string | null;
  checkPattern: string | null;
  /** 行頭の種類（AIX【物件確認した（募集状況）】／返信／内覧） */
  kindLabel: string;
  /** やる事（具体） */
  task: string;
  /** 仕事が立った時（経過日数の起点） */
  originAt: string;
  /** 期限（この時刻までに）。日の中の時刻が無い物はその日の終わり */
  dueAt: string;
  /** 期限に時刻があるか（内覧 13:00 等） */
  dueHasTime: boolean;
  doneAt: string | null;
};
export type TodoCustomer = {
  conversationId: string; name: string; accountLabel: string; status: string | null;
  items: TodoItem[];
};
export type TodoList = { atMs: number; customers: TodoCustomer[]; openCount: number; doneCount: number; skipped: Record<string, number> };

// ─── 小さな道具 ────────────────────────────────────────────────────────
const t = (iso: string | null | undefined) => { const v = Date.parse(iso ?? ""); return Number.isFinite(v) ? v : NaN; };
/** JST の日の番号（同じ日なら同じ値） */
const jstYmdOf = (ms: number) => new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
/**
 * スタッフの営業日（2026-10-21 竹内さん「営業時間外のお客様の連絡は翌営業日の今日として扱う」）:
 *   その日の最後の一覧（20:30）より後に立った物は翌日の物（翌朝の一覧で「期限 今日中」・経過はその日から数える）。
 *   営業日 n ＝ JST の [前日 20:30, 当日 20:30)。期限・経過・「今日済んだ」はこの営業日で数える（内覧・朝の挨拶の時刻は JST のまま）
 */
export const STAFF_BIZ_DAY_END_MIN = 20 * 60 + 30;
const BIZ_SHIFT_MS = (24 * 60 - STAFF_BIZ_DAY_END_MIN) * 60_000;
export const bizDayNo = (ms: number) => Math.floor((ms + JST_OFFSET_MS + BIZ_SHIFT_MS) / DAY);
const bizDayStartMs = (ms: number) => bizDayNo(ms) * DAY - JST_OFFSET_MS - BIZ_SHIFT_MS;
const endOfBizDayIso = (ms: number) => new Date(bizDayStartMs(ms) + DAY - 1).toISOString();
/** 営業日の日付（M/D） */
const bizMd = (ms: number) => { const d = new Date(bizDayNo(ms) * DAY); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };

/** スタッフのグループでのお客様の出し方: 今ある通知（AIX要対応リスト・ターゲット）と同じ「名前さん」＋アカウント名（社内のグループなので伏せない） */
export function customerHeader(name: string | null | undefined, account: string | null | undefined): string {
  const n = (name ?? "").trim() || "お客様";
  const key = normalizeLineAccountKey(account);
  const acc = key ? LINE_ACCOUNT_LABELS[key] : (account ?? "").trim();
  return `${n}さん${acc ? `（${acc}）` : ""}`;
}

/** AIX ボタンごとの「やる事」の言葉（具体の中身＝物件名・確認の中身は約束の行から足す） */
const ACTION_TASK: Record<string, string> = {
  property_send: "ご条件に合うお部屋をピックアップしてお送りする",
  property_recommendation: "1件に絞ったオススメのお部屋をお送りする",
  property_check_result: "管理会社に募集状況を確認して結果をお伝えする",
  estimate_sheet: "御見積書を作ってお送りする",
  viewing_invite: "内覧の候補日をお送りする",
  meeting_place: "待ち合わせの場所と時間をお送りする",
  greeting_viewing: "内覧の前にご挨拶を送る",
  condition_hearing: "ご希望の条件を伺う",
  application_push: "お申込みのご案内をする",
  followup_revive: "追客のご連絡をする",
  acknowledge_check: "代表に初期費用の割引を確認するとお伝えする",
  cost_explain: "初期費用の仕組みをご説明する",
  cost_breakdown: "初期費用の内訳をご説明する",
  phone_call: "お電話する",
  phone_followup: "お電話の内容をまとめて送る",
  guarantor_info: "保証会社のご案内をする",
  zenryoku_support: "新着が出次第お送りするとお伝えする",
  property_search: "お部屋を探す",
};
const CHECK_TOPIC: Record<string, string> = {
  nearby_parking: "近隣の月極駐車場", mgmt_initial_cost: "初期費用・礼金等の交渉", mgmt_guarantor: "保証会社・審査",
  mgmt_company: "管理会社", mgmt_pet: "ペット可否", vacate_date: "退去予定日", mgmt_move_in: "入居可能日",
  mgmt_parking: "駐車場", mgmt_equipment: "設備",
};
export function actionTask(action: string, checkPattern?: string | null): string {
  if (action === "property_check_result" && checkPattern && CHECK_TOPIC[checkPattern]) return `管理会社に${CHECK_TOPIC[checkPattern]}を確認して結果をお伝えする`;
  return ACTION_TASK[action] ?? `${AIX_BUTTON_LABELS[action] ?? action}を送る`;
}

/** 申込までの地図での近さ（大きいほど申込に近い）: AIX が指す駅と会話の状態の段階の大きい方 */
export function routeRank(action: string | null, status: string | null): number {
  let fromAction = -1;
  if (action) {
    MAIN_ROUTE.forEach((id: RouteNodeId, i) => { if (ROUTE_NODES[id].next.aix.includes(action)) fromAction = Math.max(fromAction, i); });
  }
  // 状態の段階（0〜7）を地図の駅の数に寄せる（viewing=3 → 内覧予定の辺り）
  const st = STATUS_STAGE_RANK[(status ?? "").trim()];
  const fromStatus = st === undefined ? -1 : Math.round((st / 4) * (MAIN_ROUTE.indexOf("applying")));
  return Math.max(fromAction, fromStatus);
}

/** お礼・了承・挨拶だけの発言（返信が要らないことが多い・やる事にしない） */
const CLOSER_PHRASES = /ありがとうございます|ありがとうございました|ありがとう|有難うございます|了解(?:です|しました|致しました)?|承知(?:しました|致しました|いたしました)?|かしこまりました|よろしくお願い(?:します|致します|いたします)|宜しくお願い(?:します|致します|いたします)|お願いします|分かりました|わかりました|はい|OKです|ok|おけです|\[(?:スタンプ|画像|動画)\]/gi;
export function isCloserOnly(text: string | null | undefined): boolean {
  const s = (text ?? "").replace(CLOSER_PHRASES, "").replace(/[\s!！?？。、.,…~〜ー\-♪☺️😊🙇‍♀️🙇‍♂️🙇🙏✨😌😭🥺👍]/gu, "").replace(/\p{Extended_Pictographic}/gu, "");
  return s.length <= 2;
}

/** 約束の行の見出しからやる事（【必ず】・【今日中】・【連絡日 …】・待ちの印を外す） */
export function promiseTaskOf(notes: string | null | undefined): string {
  const head = ((notes ?? "").trimStart().split("\n")[0] ?? "");
  return head.replace(PROMISE_MUST_MARK, "").split(TODAY_MARK).join("").replace(/【連絡日 [0-9-]+】/, "").replace(/【[^】]*待ち】/g, "").trim();
}
/** 約束の行の AIX の言葉（「AIX: 【確認した（条件・交渉）→駐車場】を送ったら完了」→ AIX【確認した（条件・交渉）→駐車場】） */
export function promiseAixLabelOf(notes: string | null | undefined): string | null {
  const m = String(notes ?? "").match(/AIX: 【([^】]+)】/);
  return m ? `AIX【${m[1].replace(/（または[^）]*）/, "").trim()}】` : null;
}

const UNANSWERED_MIN_MS = 30 * 60_000;
/**
 * 約束の行を今日のやる事に載せる上限（約束の日から）。カレンダーの【必ず】は履行するまで閉じない＝お客様が黙って失注した会話の約束も残る
 *   （10/20 の本番: 開いている約束のうち 14日より前の物の多くは会話が 2週間以上動いていない）。
 *   ピックアップの宣言の履行は 14日以内が 79.8%（announce-aix-actions の根拠）→ 14日を過ぎた約束は一覧に出さない（数は skipped に残す）
 */
export const TODO_MAX_AGE_DAYS = 14;
/** 申込より後（審査管理の領分）・失注の会話は、約束と未返信をやる事にしない（AIX 要対応は今の一覧と同じく出す） */
function postApplyOrClosed(c: TodoConversation | undefined): boolean {
  return !!c && (!!c.is_post_apply || DRAFT_SKIP_STATUSES.has((c.status ?? "").trim()) || c.status === "closed_lost");
}
const UNANSWERED_MAX_MS = 48 * 3600_000;
const FULFIL_KINDS: ReadonlySet<string> = new Set(["properties_sent", "estimate_sent", "confirmation_reported", "guarantor_explained"]);

/** 約束の行が済んだ時刻: 行を作った後の履行の送信を古い順に照らし、カレンダーを閉じる判定（planPromiseCompletion）が閉じる最初の送信 */
export function promiseDoneAt(row: TodoPromiseRow, facts: ReadonlyArray<TodoFactRow>): string | null {
  const created = t(row.created_at);
  const mine = facts.filter((f) => f.conversation_id === row.conversation_id && FULFIL_KINDS.has(f.kind) && t(f.sent_at) >= created)
    .sort((a, b) => t(a.sent_at) - t(b.sent_at));
  for (const f of mine) {
    const ids = planPromiseCompletion([{ kind: f.kind as LedgerKind, object: f.detail?.object ?? null, checkPattern: f.detail?.checkPattern ?? null }],
      [{ id: row.id, event_type: row.event_type, notes: row.notes, is_done: false }]);
    if (ids.includes(row.id)) return f.sent_at;
    // 連絡の日の約束は物件の送付で閉じる（contact-promise.planContactPromiseSync と同じ）
    if (/【連絡日 /.test(row.notes ?? "") && f.kind === "properties_sent") return f.sent_at;
  }
  return null;
}

// ─── LINE から済みを読む（2026-10-21 竹内さん G3「基本は LINE から自動で判断出来れば理想」）───────────
/**
 * AIX 要対応の仕事を済ませる送信（sent_facts の done）。AIX のボタンを押さずに送った（物件のリンクを貼った・御見積書の画像を送った）時も、
 * 送信の記録が立てば済み。10/15〜10/20 の見本で「AIX 要対応が開いたまま、4分後に物件を送っていた」型の「まだ」を減らす
 */
export const AIX_FULFIL_FACT: Readonly<Record<string, readonly string[]>> = {
  property_send: ["properties_sent"], property_recommendation: ["properties_sent"],
  estimate_sheet: ["estimate_sent"], property_check_result: ["confirmation_reported"],
  viewing_invite: ["viewing_invited"], meeting_place: ["meeting_place_sent"], condition_hearing: ["condition_asked"],
  application_push: ["application_guided"], cost_explain: ["cost_explained"], cost_breakdown: ["cost_breakdown_explained"],
  guarantor_info: ["guarantor_explained"], phone_call: ["call_requested"], phone_followup: ["call_followup_sent"],
  followup_revive: ["followup_sent"],
};
function factsOf(facts: ReadonlyArray<TodoFactRow>, cid: string, fromMs: number, toMs: number, kinds?: readonly string[]): TodoFactRow[] {
  return facts.filter((f) => f.conversation_id === cid && t(f.sent_at) >= fromMs && t(f.sent_at) <= toMs && (!kinds || kinds.includes(f.kind)))
    .sort((a, b) => t(a.sent_at) - t(b.sent_at));
}
/** AIX 要対応が送信で済んだ時刻（立った後・at まで）。無ければ null */
export function aixDoneByFact(r: Pick<TodoAixItemRow, "conversation_id" | "action" | "created_at">, facts: ReadonlyArray<TodoFactRow>, atMs: number): string | null {
  const kinds = AIX_FULFIL_FACT[r.action];
  if (!kinds) return null;
  return factsOf(facts, r.conversation_id, t(r.created_at), atMs, kinds)[0]?.sent_at ?? null;
}
const CONDITION_WAIT_MS = 10 * 60_000;
const COST_CONFIRM_RE = /初期費用|交渉|割引|値引|見積|仲介手数料|礼金/;
/**
 * もう要らなくなった約束（済みではなく、やる事から外す）。理由の札を返す（無ければ null）
 *   apply   … 約束の後に申込のご案内をした（物件出し・確認・御見積書の前の段の約束は申込に進めば終わり）
 *   cond    … 「ご条件を頂いたらピックアップします」の約束（条件を伺った送信と同じ時に立った物件の約束）で、まだお客様が返していない＝お客様待ち
 *   gone    … 初期費用・交渉の確認の約束の後に、そのお部屋の募集終了・別のお部屋の報告をした（確かめる対象が無くなった）
 */
export function promiseMootReason(p: TodoPromiseRow, input: Pick<TodoInput, "facts" | "customerTurns">, atMs: number): "apply" | "cond" | "gone" | null {
  if (!p.conversation_id) return null;
  const created = t(p.created_at);
  if (factsOf(input.facts, p.conversation_id, created, atMs, ["application_guided"]).length) return "apply";
  const action = promiseAixActionOf(p.event_type);
  if (action === "property_send" && input.customerTurns) {
    const asked = input.facts.some((f) => f.conversation_id === p.conversation_id && f.kind === "condition_asked" && Math.abs(t(f.sent_at) - created) <= CONDITION_WAIT_MS);
    const replied = input.customerTurns.some((m) => m.conversation_id === p.conversation_id && t(m.created_at) > created && t(m.created_at) <= atMs);
    if (asked && !replied) return "cond";
  }
  if (action === "property_check_result" && COST_CONFIRM_RE.test(promiseTaskOf(p.notes))) {
    const gone = factsOf(input.facts, p.conversation_id, created, atMs, ["confirmation_reported"])
      .some((f) => f.detail?.checkPattern === "unavailable" || f.detail?.checkPattern === "alternative");
    if (gone) return "gone";
  }
  return null;
}
const VIEWING_DONE_TEXT_RE = /内覧|ご案内|お越し/;
/** 内覧が済んだ時刻: 内覧の記録 → 内覧の時刻の後のスタッフの送信（内覧のお礼・ご案内の話）→ 時刻の後の申込のご案内 */
export function viewingDoneAt(v: TodoViewingRow, dueMs: number, input: Pick<TodoInput, "facts" | "messages">, atMs: number): string | null {
  const reportMs = t(v.viewing_report_at);
  if (Number.isFinite(reportMs) && reportMs <= atMs) return v.viewing_report_at!;
  if (!v.conversation_id || dueMs > atMs) return null;
  const staff = input.messages.filter((m) => m.conversation_id === v.conversation_id && m.sender !== "customer"
    && t(m.created_at) > dueMs && t(m.created_at) <= atMs && VIEWING_DONE_TEXT_RE.test(m.text ?? ""))
    .sort((a, b) => t(a.created_at) - t(b.created_at))[0];
  const applied = factsOf(input.facts, v.conversation_id, dueMs, atMs, ["application_guided"])[0];
  const cands = [staff?.created_at, applied?.sent_at].filter((x): x is string => !!x).sort((a, b) => t(a) - t(b));
  if (cands[0]) return cands[0];
  return v.status === "done" ? new Date(dueMs).toISOString() : null;
}
/** グループの✅の時刻（at まで） */
function markedAt(key: string, marks: ReadonlyArray<TodoMarkRow> | undefined, atMs: number): string | null {
  const m = (marks ?? []).filter((x) => x.item_key === key && t(x.marked_at) <= atMs).sort((a, b) => t(a.marked_at) - t(b.marked_at))[0];
  return m?.marked_at ?? null;
}
const earliest = (...xs: Array<string | null | undefined>): string | null =>
  xs.filter((x): x is string => !!x && Number.isFinite(t(x))).sort((a, b) => t(a) - t(b))[0] ?? null;

// ─── 組み立て ───────────────────────────────────────────────────────────
export function buildStaffTodoList(input: TodoInput): TodoList {
  const at = input.atMs;
  const dayStart = bizDayStartMs(at); // 「今日済んだ」の起点＝営業日の始まり（前日 20:30）
  const jstStart = jstDayStartMs(at); // 内覧・朝の挨拶の時刻の起点（JST の 0:00）
  const today = bizDayNo(at);
  const skipped: Record<string, number> = {};
  const skip = (k: string) => { skipped[k] = (skipped[k] ?? 0) + 1; };
  const convById = new Map(input.conversations.map((c) => [c.id, c]));
  const items: TodoItem[] = [];

  // ① AIX 要対応（その時点で未完了だった物＋今日済んだ物）
  const openAixConv = new Set<string>();
  for (const r of input.aixItems) {
    if (isTestConversation(r.conversation_id)) { skip("test"); continue; }
    const created = t(r.created_at);
    if (!(created <= at)) continue;
    const doneMs = r.status === "done" ? t(r.done_at) : NaN;
    const closedMs = r.status === "done" ? doneMs : r.status === "dismissed" ? t(r.updated_at) : NaN;
    let openAtAt = r.status === "pending" || (Number.isFinite(closedMs) && closedMs > at);
    let doneToday = r.status === "done" && Number.isFinite(doneMs) && doneMs >= dayStart && doneMs <= at;
    let doneAtShown: string | null = r.done_at;
    if (openAtAt) {
      // AIX のボタンを押さずに済ませた（送信の記録）・グループの✅
      const auto = earliest(aixDoneByFact(r, input.facts, at), markedAt(`aix:${r.id}`, input.marks, at));
      if (auto) {
        if (t(auto) < dayStart) { skip("aix_done_by_send_before"); continue; }
        openAtAt = false; doneToday = true; doneAtShown = auto;
      }
    }
    if (!openAtAt && !doneToday) continue;
    // 14日より前に立って開いたままの要対応（台帳に未履行のピックアップ宣言があると取り下げない物）も、約束と同じく今日のやる事にしない
    if (openAtAt && today - bizDayNo(created) > TODO_MAX_AGE_DAYS) { skip("aix_stale"); continue; }
    const morning = (r.resolution_note ?? "").startsWith(MORNING_GREETING_NOTE_PREFIX);
    const appt = morning ? (r.resolution_note ?? "").slice(MORNING_GREETING_NOTE_PREFIX.length).trim() : "";
    const shownAction = doneToday && r.done_aix_type && r.done_aix_type !== r.action ? r.done_aix_type : r.action;
    const task = morning ? `本日${appt ? ` ${appt} ` : ""}の内覧の前にご挨拶を送る` : actionTask(r.action, r.check_pattern);
    // 期限: その日のうち（ブレインが要ると判断した番・約束の続き）。朝の挨拶は内覧の時刻
    const hm = appt.match(/(\d{1,2}):(\d{2})/);
    const dueAt = morning && hm ? new Date(jstStart + (+hm[1] * 60 + +hm[2]) * 60_000).toISOString() : endOfBizDayIso(created);
    if (openAtAt) openAixConv.add(r.conversation_id);
    items.push({
      key: `aix:${r.id}`, conversationId: r.conversation_id, source: "aix_item", action: r.action, checkPattern: r.check_pattern,
      kindLabel: aixButtonText(shownAction, shownAction === r.action ? r.check_pattern : null),
      task: (r.resolution_note ?? "").startsWith(PROMISE_QUEUE_NOTE_PREFIX) ? `${task}（約束の続き）` : task,
      originAt: r.created_at, dueAt, dueHasTime: !!(morning && hm), doneAt: openAtAt ? null : doneAtShown,
    });
  }

  // ② お客様への約束（【必ず】）
  for (const p of input.promises) {
    if (!p.conversation_id || isTestConversation(p.conversation_id)) { skip("test"); continue; }
    const created = t(p.created_at);
    if (!(created <= at)) continue;
    if (isWaitPromiseNotes(p.notes, at)) { skip("promise_wait"); continue; }
    const due = t(p.start_at);
    if (bizDayNo(due) > today) { skip("promise_future"); continue; }
    if (postApplyOrClosed(convById.get(p.conversation_id))) { skip("promise_post_apply"); continue; }
    // 済み: 履行の送信（カレンダーを閉じるのと同じ判定・カレンダーがまだ開いていても送信が立てば済み）・グループの✅
    let doneAt: string | null = earliest(promiseDoneAt(p, input.facts), markedAt(`promise:${p.id}`, input.marks, at));
    // 閉じたのに履行の送信も✅も見つからない（画面で手で完了・別の判定）＝いつ済んだか分からないので出さない
    if (p.is_done && !doneAt) { skip("promise_closed_unknown"); continue; }
    if (doneAt && t(doneAt) > at && !p.is_done) doneAt = null;
    // もう要らない約束（申込に進んだ・お客様のご条件待ち・確かめるお部屋が無くなった）はやる事から外す
    if (!(doneAt && t(doneAt) <= at)) {
      const moot = promiseMootReason(p, input, at);
      if (moot) { skip(`promise_moot_${moot}`); continue; }
    }
    const doneMs = doneAt ? t(doneAt) : NaN;
    if (doneAt && doneMs <= at && doneMs < dayStart) continue; // 今日より前に済んだ
    if (!(doneAt && doneMs <= at) && today - bizDayNo(due) > TODO_MAX_AGE_DAYS) { skip("promise_stale"); continue; }
    const isDoneNow = !!doneAt && doneMs <= at;
    const action = promiseAixActionOf(p.event_type);
    items.push({
      key: `promise:${p.id}`, conversationId: p.conversation_id, source: "promise", action, checkPattern: promiseCheckPatternOf(p.notes),
      kindLabel: promiseAixLabelOf(p.notes) ?? (action ? aixButtonText(action) : "約束"),
      task: `${promiseTaskOf(p.notes)}（お約束）`,
      originAt: p.created_at, dueAt: endOfBizDayIso(due), dueHasTime: false, doneAt: isDoneNow ? doneAt : null,
    });
  }

  // ③ 今日の内覧
  const todayYmd = jstYmdOf(at);
  for (const v of input.viewings) {
    if (!v.conversation_id || isTestConversation(v.conversation_id)) continue;
    if (v.scheduled_date !== todayYmd || /cancel/.test(v.status ?? "")) continue;
    const hm = (v.scheduled_time ?? "").match(/(\d{1,2}):(\d{2})/);
    const dueMs = hm ? jstStart + (+hm[1] * 60 + +hm[2]) * 60_000 : jstStart + DAY - 1;
    const doneAt = earliest(viewingDoneAt(v, dueMs, input, at), markedAt(`viewing:${v.id}`, input.marks, at));
    items.push({
      key: `viewing:${v.id}`, conversationId: v.conversation_id, source: "viewing", action: null, checkPattern: null, kindLabel: "内覧",
      task: `${hm ? `${hm[1]}:${hm[2]} ` : ""}${v.property_name ? `${v.property_name}の` : ""}ご案内（終わったら内覧の記録）`,
      originAt: new Date(jstStart).toISOString(), dueAt: new Date(dueMs).toISOString(), dueHasTime: !!hm, doneAt,
    });
  }

  // ④ まだ返していないお客様の発言（AIX 要対応が立っている会話は①が持つ）
  const lastByConv = new Map<string, TodoMessageRow[]>();
  for (const m of input.messages) {
    if (!(t(m.created_at) <= at)) continue;
    const arr = lastByConv.get(m.conversation_id) ?? []; arr.push(m); lastByConv.set(m.conversation_id, arr);
  }
  for (const [cid, msgs] of lastByConv) {
    if (isTestConversation(cid) || openAixConv.has(cid)) continue;
    const conv = convById.get(cid);
    if (!conv || postApplyOrClosed(conv)) continue;
    msgs.sort((a, b) => t(a.created_at) - t(b.created_at));
    const last = msgs[msgs.length - 1];
    if (last.sender !== "customer") continue;
    // 続けて送られた発言のまとまり（最後のこちらの発言の後）
    let i = msgs.length - 1; while (i > 0 && msgs[i - 1].sender === "customer") i--;
    const turn = msgs.slice(i);
    const first = t(turn[0].created_at), lastMs = t(last.created_at);
    if (at - lastMs < UNANSWERED_MIN_MS || at - first > UNANSWERED_MAX_MS) { skip("unanswered_window"); continue; }
    if (turn.every((m) => isCloserOnly(m.text))) { skip("unanswered_closer"); continue; }
    const key = `reply:${cid}:${turn[0].created_at}`;
    const marked = markedAt(key, input.marks, at);
    if (marked && t(marked) < dayStart) continue;
    items.push({
      key, conversationId: cid, source: "unanswered", action: null, checkPattern: null, kindLabel: "返信",
      task: `${jstMDHm(turn[0].created_at)} のご連絡に返信する`,
      originAt: turn[0].created_at, dueAt: endOfBizDayIso(first), dueHasTime: false, doneAt: marked,
    });
  }

  // 重なり: 同じ会話・同じ AIX の要対応と約束は1行に（約束の言葉＝中身が具体・経過は古い方から）
  const merged: TodoItem[] = [];
  for (const it of items.sort((a, b) => (a.source === "promise" ? -1 : 0) - (b.source === "promise" ? -1 : 0))) {
    const same = it.action ? merged.find((m) => m.conversationId === it.conversationId && m.action === it.action && !!m.doneAt === !!it.doneAt
      && (it.action !== "property_check_result" || !m.checkPattern || !it.checkPattern || m.checkPattern === it.checkPattern)) : undefined;
    if (!same) { merged.push({ ...it }); continue; }
    if (t(it.originAt) < t(same.originAt)) same.originAt = it.originAt;
    if (t(it.dueAt) < t(same.dueAt)) { same.dueAt = it.dueAt; same.dueHasTime = it.dueHasTime; }
    if (it.source === "aix_item" && it.checkPattern && !same.checkPattern) { same.checkPattern = it.checkPattern; same.kindLabel = it.kindLabel; }
    skip("merged");
  }

  // お客様ごと
  const byConv = new Map<string, TodoItem[]>();
  for (const it of merged) { const a = byConv.get(it.conversationId) ?? []; a.push(it); byConv.set(it.conversationId, a); }
  const customers: TodoCustomer[] = [];
  for (const [cid, its] of byConv) {
    const conv = convById.get(cid);
    const name = conv?.customer_name ?? input.aixItems.find((r) => r.conversation_id === cid)?.customer_name ?? input.promises.find((p) => p.conversation_id === cid)?.customer_name ?? null;
    its.sort((a, b) => compareItems(a, b, at, conv?.status ?? null));
    customers.push({ conversationId: cid, name: (name ?? "").trim() || "お客様", accountLabel: customerHeader(name, conv?.account ?? null), status: conv?.status ?? null, items: its });
  }
  customers.sort((a, b) => compareCustomers(a, b, at));
  const openCount = merged.filter((i) => !i.doneAt).length;
  return { atMs: at, customers, openCount, doneCount: merged.length - openCount, skipped };
}

/** 期限を過ぎた日数（その日の終わりが期限の物は翌日から 1） */
export function overdueDays(it: Pick<TodoItem, "dueAt">, atMs: number): number {
  return Math.max(0, bizDayNo(atMs) - bizDayNo(t(it.dueAt)));
}
/** 仕事が立ってからの経過日数（JST の日付で数える・今日立った物は 0） */
export function elapsedDays(it: Pick<TodoItem, "originAt">, atMs: number): number {
  return Math.max(0, bizDayNo(atMs) - bizDayNo(t(it.originAt)));
}
function compareItems(a: TodoItem, b: TodoItem, at: number, status: string | null): number {
  if (!!a.doneAt !== !!b.doneAt) return a.doneAt ? 1 : -1;
  if (a.doneAt && b.doneAt) return t(a.doneAt) - t(b.doneAt);
  return overdueDays(b, at) - overdueDays(a, at)
    || t(a.dueAt) - t(b.dueAt)
    || elapsedDays(b, at) - elapsedDays(a, at)
    || routeRank(b.action, status) - routeRank(a.action, status);
}
/** お客様の並び: 残りがある人を先に → 期限を過ぎた日数 → 経過日数 → 申込に近い → 早く立った順 */
function compareCustomers(a: TodoCustomer, b: TodoCustomer, at: number): number {
  const open = (c: TodoCustomer) => c.items.filter((i) => !i.doneAt);
  const ao = open(a), bo = open(b);
  if (!!ao.length !== !!bo.length) return ao.length ? -1 : 1;
  const max = (xs: TodoItem[], f: (i: TodoItem) => number) => xs.reduce((m, i) => Math.max(m, f(i)), -1);
  const min = (xs: TodoItem[], f: (i: TodoItem) => number) => xs.reduce((m, i) => Math.min(m, f(i)), Infinity);
  const xa = ao.length ? ao : a.items, xb = bo.length ? bo : b.items;
  return max(xb, (i) => overdueDays(i, at)) - max(xa, (i) => overdueDays(i, at))
    || max(xb, (i) => elapsedDays(i, at)) - max(xa, (i) => elapsedDays(i, at))
    || max(xb, (i) => routeRank(i.action, b.status)) - max(xa, (i) => routeRank(i.action, a.status))
    || min(xa, (i) => t(i.originAt)) - min(xb, (i) => t(i.originAt));
}

// ─── LINE の文 ─────────────────────────────────────────────────────────
function dueLabel(it: TodoItem, atMs: number): string {
  const od = overdueDays(it, atMs);
  const due = new Date(t(it.dueAt) + JST_OFFSET_MS);
  const md = it.dueHasTime ? `${due.getUTCMonth() + 1}/${due.getUTCDate()}` : bizMd(t(it.dueAt)); // 期限が日の物は営業日の日付
  if (od > 0) return `期限 ${md} 過ぎ`;
  if (it.dueHasTime) return `期限 ${String(due.getUTCHours())}:${String(due.getUTCMinutes()).padStart(2, "0")}まで`;
  return "期限 今日中";
}
/** 残りの行の番号（グループで「✅3」と返すための番号・①〜㊿、51 からは (51)） */
export function todoNumberMark(n: number): string {
  if (n >= 1 && n <= 20) return String.fromCodePoint(0x2460 + n - 1);
  if (n >= 21 && n <= 35) return String.fromCodePoint(0x3251 + n - 21);
  if (n >= 36 && n <= 50) return String.fromCodePoint(0x32b1 + n - 36);
  return `(${n})`;
}
/** 残りの行に上から番号を振る（文と、グループの✅を読む控え（スナップショット）で同じ番号） */
export function numberTodoItems(list: TodoList): Array<{ n: number; item: TodoItem; customer: TodoCustomer }> {
  const out: Array<{ n: number; item: TodoItem; customer: TodoCustomer }> = [];
  for (const c of list.customers) for (const i of c.items) if (!i.doneAt) out.push({ n: out.length + 1, item: i, customer: c });
  return out;
}
/**
 * 1行: ①AIX【種類】：やる事（期限）（●日）／済みは ✅AIX【種類】：やる事。
 * 経過が0日（今日立った）の物は（0日）を書かない（2026-10-21 竹内さん G5「０にちいれない」）
 */
export function renderTodoItem(it: TodoItem, atMs: number, n?: number): string {
  if (it.doneAt) return `✅${it.kindLabel}：${it.task}`;
  const d = elapsedDays(it, atMs);
  return `${n ? todoNumberMark(n) : "・"}${it.kindLabel}：${it.task}（${dueLabel(it, atMs)}）${d > 0 ? `（${d}日）` : ""}`;
}
/** グループに出す文（やる事が1つも無ければ null＝送らない） */
export function renderStaffTodoList(list: TodoList): string | null {
  if (list.customers.length === 0) return null;
  const nums = new Map(numberTodoItems(list).map((x) => [x.item.key, x.n]));
  const out = [`【やることリスト】${jstMDHm(list.atMs)}`];
  for (const c of list.customers) {
    out.push("", c.accountLabel, ...c.items.map((i) => renderTodoItem(i, list.atMs, nums.get(i.key))));
  }
  out.push("", list.openCount === 0 ? "🎉 全部✅！" : `残り ${list.openCount}件／済み ${list.doneCount}件（✅=済み・（●日）=経過日数）`);
  if (list.openCount > 0) out.push("済んだら「✅3」「✅3 5」や「〇〇さん 完了」とこのグループに返すと✅になります（LINE で送った物は自動で✅）");
  return out.join("\n");
}
