// app/lib/customer-hub.ts — つなぎのブレイン 段2「お客様ごとの共通の状態（ハブ）」（純関数・DB も fetch も LLM も持たない）
//
// 2026-10-21 竹内さん（設計知見 98bca000「つなぎを太くする」・e07a8b73「つなぎのブレイン」・統括ブレインの最終目標）:
//   統括ブレインがお客様の全部（今どこ・約束・予定・物件・誰が動くか）を1つの物で掴み、専門のブレイン（LINE 等）へ指示を出す土台。
//   ここはその「1つの状態」を、**今ある計算をそのまま使って**組み立てるだけ（作り直さない）:
//     今どこ      = customer-state.resolveCustomerState → apply-route-map.locateApplyRoute
//     約束        = promise-queue（ピッカー鍵つき）・promise-tracker・request-ledger・calendar_events の【必ず】・contact-promise（連絡日）
//     次の一手    = promise-queue.nextPromiseAix・aix_action_items（要対応）・staff-todo-list（やることリスト）・地図の次の一手
//     予定        = customer-state の内覧（viewing_history＋本文）・calendar_events（内覧・連絡日）
//     物件        = customer-state のお部屋・property_pickups（送れる物件＝link-brain-watch.pickupReadyAt）・reaction-negatives（反応）
//     印          = reapply-customer（申込歴あり）・post-apply.judgeParallelSecond（2番手で申込中＝並行で探す・下書き・ブレイン・個人情報の門と同じ判定）・screening-sensitive（審査の事情＝Claude だけ）
//   それぞれの元の間の食い違い（hubContradictions）＝司令塔が次に決めるべき所。
//
// 線: 本番の動き（プロンプト・返信・AIX）には何もつながない。見張り（link-brain-watch）が読めるのは LINK_HUB=on の時だけ（既定 off）。
// テスト: app/lib/__tests__/customer-hub.test.ts
import { resolveCustomerState, STAGE_LABEL, type CustomerState, type CustomerStateInput, type CustomerStage, type Conflict } from "./customer-state";
import { buildActionLedger, type ActionLedger } from "./action-ledger";
import { locateApplyRoute, ROUTE_NODES, ROUTE_BRANCHES, type ApplyRouteLocation } from "./apply-route-map";
import { buildPromiseQueue, nextPromiseAix, promiseStepLabel, PROMISE_QUEUE_MAX_AGE_MS, type PromiseStep, type QueueMsg, type QueueAixLog } from "./promise-queue";
import { trackPromises } from "./promise-tracker";
import { buildRequestLedger } from "./request-ledger";
import { isContactPromiseNotes, contactDateOfNotes } from "./contact-promise";
import { PROMISE_MUST_MARK, promiseAixActionOf, promiseCheckPatternOf } from "./promise-calendar";
import { buildStaffTodoList, type TodoAixItemRow, type TodoPromiseRow, type TodoItem } from "./staff-todo-list";
import { screeningSensitiveInMessages, type ScreeningSensitiveHit } from "./screening-sensitive";
import { REACTION_ATTR_JA, type ReactionState } from "./reaction-negatives";
import { RETURN_PATTERN_SHORT, type ReapplyInfo } from "./reapply-customer";
import { pickupReadyAt, type LinkPickup, type LinkMemoItem } from "./link-brain-watch";
import { isPreApplyForNudge } from "./apply-stage-nudge";
import { judgeParallelSecond } from "./post-apply";
import { PARALLEL_STATUSES, PARALLEL_2ND_LABEL } from "./parallel-second";
import { maskPII } from "./pii-mask";

const H = 3600_000;
const DAY = 24 * H;
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const iso = (n: number) => new Date(n).toISOString();

/** 切替: 見張り（link-brain-watch）がハブを読む（既定 off・LINK_HUB=on で読む）。本番の返信・AIX には関係しない */
export function linkHubEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.LINK_HUB ?? "").trim().toLowerCase() === "on";
}

// ───────── 材料（DB の行・読むだけ） ─────────
export type HubCalendarEvent = TodoPromiseRow & { title?: string | null; all_day?: boolean | null };
export type HubAixItem = TodoAixItemRow & { dismissed_reason?: string | null };
export type HubInput = {
  nowMs: number;
  conv: { id: string; customer_name: string | null; account?: string | null; status: string | null; is_post_apply?: boolean | null; status_manual_back_at?: string | null };
  /** customer-state の材料（messages は古い順・aixRows は送った物） */
  state: CustomerStateInput;
  aixItems: ReadonlyArray<HubAixItem>;
  pickups: ReadonlyArray<LinkPickup>;
  calendarEvents: ReadonlyArray<HubCalendarEvent>;
  memoItems?: ReadonlyArray<LinkMemoItem>;
  /** 反応（reaction-negatives・読めなければ null） */
  reactions?: ReactionState | null;
  /** 申込歴あり（reapply-customer・無ければ null） */
  reapply?: ReapplyInfo | null;
  /**
   * 2番手で申込中（並行で探す）。読み手（customer-hub-server）が記録から読んだ物（post-apply.loadParallelSecondActive・読めなければ null）。
   *   渡さない時（試し・過去の時点）は、この材料から同じ純関数（post-apply.judgeParallelSecond）で決める
   */
  parallelSecond?: boolean | null;
};

// ───────── 出力 ─────────
export type HubActor = "brain" | "aix" | "staff" | "none";
export type HubPromise = {
  source: "queue" | "tracker" | "request" | "calendar" | "contact";
  /** 種類（queue=PromiseKind／tracker=約束の種類／request=依頼の話題／calendar=event_type／contact="連絡日"） */
  kind: string;
  label: string;
  /** 果たす AIX（無ければ null） */
  action: string | null;
  checkPattern: string | null;
  pickerKey: string | null;
  object: string | null;
  promisedAt: string;
  dueAt: string | null;
  overdue: boolean;
  watch?: boolean;
  deferred?: boolean;
  /** 根拠の文（伏せる前・表示は renderCustomerHub が伏せる） */
  evidence?: string;
};
export type HubNextAction = { by: HubActor; action: string | null; checkPattern: string | null; label: string; dueAt: string | null; source: "promise_queue" | "aix_item" | "todo" | "route" | "pickup_ready" };
export type HubScheduleItem = { kind: "viewing" | "contact" | "promise" | "other"; at: string; label: string; done: boolean; source: "customer_state" | "calendar" };
export type CustomerHub = {
  conversationId: string;
  atIso: string;
  where: {
    stage: CustomerStage | null; stageLabel: string | null; since: string | null;
    node: string | null; nodeName: string | null; branch: string | null; branchName: string | null;
    next: ApplyRouteLocation["next"]; wayBack: ApplyRouteLocation["wayBack"]; evidence: string[];
    statusRaw: string | null; isPostApply: boolean;
  };
  promises: HubPromise[];
  /** 果たした約束の数（queue の done・14日） */
  promisesDone: number;
  nextActions: HubNextAction[];
  schedule: HubScheduleItem[];
  properties: {
    sentCount: number;
    rooms: Array<{ name: string; status: string; estimateSent: boolean; customerInterest: boolean }>;
    focus: string | null;
    pickupsPending: number;
    pickupReady: boolean;
    reactions: { negatives: string[]; good: number; declined: number } | null;
  };
  flags: {
    reapply: boolean; reapplyPattern: string | null;
    /**
     * 2番手で申込中（並行で探す）（post-apply.judgeParallelSecond＝下書き・ブレイン・個人情報の門と同じ）。null＝記録が読めない。
     *   2026-10-21 旧の rankWaiting（申込前の status ＋「2〜9番手／繰り上が」の語）は案内の文も数え、申込中の会話は数えなかったので置き換えた
     */
    parallelSecond: boolean | null;
    screeningSensitive: ScreeningSensitiveHit | null;
    /** 生成は Claude だけ: 審査の事情がある（screening-sensitive）・2番手で申込中・申込中の会話で2番手か読めない（個人情報の門は分からなければ Claude） */
    claudeOnly: boolean;
    searching: CustomerState["searching"] | null;
  };
  actor: { who: HubActor; why: string; dueAt: string | null };
  /** customer-state が見つけたずれ（そのまま） */
  stateConflicts: Conflict[];
  todo: TodoItem[];
};

// ───────── 組み立て ─────────
/**
 * 記録を渡されない時（試し・過去の時点）の「2番手で申込中」: ハブの材料から下書き・ブレインと同じ純関数（post-apply.judgeParallelSecond）で決める。
 *   申込の記録はハブの材料にある物だけ（送った AIX の申込へ）＝本番の読み手（loadParallelSecondActive）が正
 */
export function parallelSecondOfHubInput(input: HubInput): boolean {
  const pushes = input.state.aixRows.filter((r) => r.aix_type === "application_push").map((r) => ms(r.created_at)).filter(Number.isFinite);
  return judgeParallelSecond(
    { status: input.conv.status, isPostApply: input.conv.is_post_apply === true, statusManualBackAt: input.conv.status_manual_back_at ?? null, applicationPushAt: pushes.length ? iso(Math.max(...pushes)) : null },
    {
      msgs: input.state.messages.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt })),
      memoItems: (input.memoItems ?? []).map((x) => ({ ...(x as { id?: string; retiredAt?: string | null }), text: x.text ?? undefined, updatedAt: x.updatedAt ?? null, sourceAt: x.sourceAt ?? null })),
    },
    input.nowMs,
  ).parallel;
}

const toQueueMsgs = (s: CustomerStateInput): QueueMsg[] => s.messages.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt, isAix: !!m.isAix }));
const toQueueLogs = (s: CustomerStateInput): QueueAixLog[] => s.aixRows.filter((r) => !!r.aix_type && (r.sent_at || r.created_at))
  .map((r) => ({ aixType: r.aix_type as string, checkPattern: r.check_pattern ?? null, sentAt: (r.sent_at ?? r.created_at) as string, estimateSent: r.estimate_sent, text: r.generated_text }));

function ledgerOf(s: CustomerStateInput, nowMs: number): ActionLedger {
  const msgs = [...s.messages].filter((m) => Number.isFinite(ms(m.createdAt))).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const lastCustomerAt = msgs.filter((m) => m.sender === "customer" && (m.text ?? "").trim()).at(-1)?.createdAt ?? null;
  return buildActionLedger({
    recentAixRows: s.aixRows.filter((r) => !!r.aix_type && (r.sent_at || r.created_at)),
    messages: msgs.map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.createdAt, isAix: !!m.isAix, lineMessageId: m.lineMessageId ?? null })),
    lineTasks: s.lineTasks ?? [], lastCustomerAt, now: nowMs, recordedFacts: s.recordedFacts ?? [],
  });
}

/** 最後のお客様の連投（まだこちらが返していない分）と、その前の72時間のこちらの本文 */
function turnOf(s: CustomerStateInput): { customerTurnText: string; customerTurnAt: string | null; recentStaffTexts: string[]; lastStaffAtIfStaffLast: string | null } {
  const newest = [...s.messages].sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  const turn: string[] = []; let at: string | null = null; let i = 0;
  for (; i < newest.length && newest[i].sender === "customer"; i++) { turn.unshift(newest[i].text ?? ""); at = newest[i].createdAt; }
  const ref = at ? ms(at) : newest[0] ? ms(newest[0].createdAt) : NaN;
  const staff: string[] = [];
  for (let j = i; j < newest.length && newest[j].sender !== "customer"; j++) {
    if (Number.isFinite(ref) && ref - ms(newest[j].createdAt) > 72 * H) break;
    staff.push(newest[j].text ?? "");
  }
  return { customerTurnText: turn.join("\n"), customerTurnAt: at, recentStaffTexts: staff, lastStaffAtIfStaffLast: newest[0] && newest[0].sender !== "customer" ? newest[0].createdAt : null };
}

export function buildCustomerHub(input: HubInput): CustomerHub {
  const now = input.nowMs;
  const s = input.state;
  const ledger = ledgerOf(s, now);
  let state: CustomerState | null = null;
  try { state = resolveCustomerState({ ...s, now, ledger }); } catch { state = null; }
  const turn = turnOf(s);
  // 2番手で申込中（並行で探す）: 下書き・ブレイン・個人情報の門・やることリスト・司令塔と同じ判定（post-apply.judgeParallelSecond）。地図の番手の分かれ道にも渡す
  const parallelSecond = input.parallelSecond !== undefined ? input.parallelSecond : parallelSecondOfHubInput(input);
  const loc = locateApplyRoute({
    stage: state?.stage ?? null, searching: state?.searching ?? null, ledger: ledger.facts,
    customerTurnText: turn.customerTurnText, recentStaffTexts: turn.recentStaffTexts, lastStaffAtIfStaffLast: turn.lastStaffAtIfStaffLast, nowMs: now,
    parallelSecond,
  });

  // ── 約束（5つの台帳を1つの並びに。台帳はまとめず上に並べるだけ＝設計の案 5-1 の小さい案） ──
  const steps = buildPromiseQueue(toQueueMsgs(s), toQueueLogs(s), now, { windowDays: 14 });
  const promises: HubPromise[] = [];
  for (const st of steps) {
    if (st.status !== "pending") continue;
    const due = ms(st.promisedAt) + PROMISE_QUEUE_MAX_AGE_MS;
    promises.push({ source: "queue", kind: st.kind, label: promiseStepLabel(st), action: st.action, checkPattern: st.checkPattern, pickerKey: st.pickerKey ?? st.checkPattern ?? null,
      object: st.object, promisedAt: st.promisedAt, dueAt: st.watch ? null : iso(due), overdue: !st.watch && due < now, watch: !!st.watch, deferred: !!st.deferred, evidence: st.evidence });
  }
  for (const o of trackPromises(s.messages.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt, isAix: m.isAix })), now).open) {
    promises.push({ source: "tracker", kind: o.kind, label: `${o.kind}（${o.status}）`, action: null, checkPattern: null, pickerKey: null, object: null,
      promisedAt: o.at, dueAt: null, overdue: o.status === "遅れ", evidence: o.sentence });
  }
  for (const r of buildRequestLedger(s.messages.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt, isAix: m.isAix })), now, { windowDays: 7 })) {
    if (r.status === "done" || r.deferred) continue;
    promises.push({ source: "request", kind: r.topic, label: `お客様の${r.kind === "question" ? "問い" : r.kind === "concern" ? "懸念" : "依頼"}（${r.status === "promised" ? "約束済み" : "未対応"}）`,
      action: null, checkPattern: null, pickerKey: null, object: null, promisedAt: r.saidAt, dueAt: null, overdue: false, evidence: r.quote });
  }
  const schedule: HubScheduleItem[] = [];
  for (const e of input.calendarEvents) {
    const notes = e.notes ?? "";
    if (isContactPromiseNotes(notes)) {
      const ymd = contactDateOfNotes(notes);
      const at = ymd ? `${ymd}T00:00:00+09:00` : e.start_at;
      if (!e.is_done) promises.push({ source: "contact", kind: "連絡日", label: `連絡日 ${ymd ?? e.start_at.slice(0, 10)}`, action: promiseAixActionOf(e.event_type), checkPattern: null, pickerKey: null, object: null,
        promisedAt: e.created_at, dueAt: iso(ms(at)), overdue: ms(at) + DAY < now });
      schedule.push({ kind: "contact", at: iso(ms(at)), label: "連絡日", done: !!e.is_done, source: "calendar" });
    } else if (notes.startsWith(PROMISE_MUST_MARK)) {
      if (!e.is_done) promises.push({ source: "calendar", kind: e.event_type ?? "other", label: (e.title ?? "【必ず】").slice(0, 40), action: promiseAixActionOf(e.event_type), checkPattern: promiseCheckPatternOf(notes),
        pickerKey: promiseCheckPatternOf(notes), object: null, promisedAt: e.created_at, dueAt: e.start_at, overdue: ms(e.start_at) + DAY < now });
      schedule.push({ kind: "promise", at: e.start_at, label: (e.title ?? "約束").slice(0, 40), done: !!e.is_done, source: "calendar" });
    } else {
      schedule.push({ kind: e.event_type === "viewing" ? "viewing" : "other", at: e.start_at, label: (e.title ?? e.event_type ?? "予定").slice(0, 40), done: !!e.is_done, source: "calendar" });
    }
  }
  for (const v of state?.viewings ?? []) schedule.push({ kind: "viewing", at: `${v.ymd}T${v.time ?? "00:00"}:00+09:00`, label: `内覧 ${v.name ?? "（物件名なし）"}・${v.status}`, done: v.status === "done" || v.status === "cancelled", source: "customer_state" });
  schedule.sort((a, b) => ms(a.at) - ms(b.at));

  // ── やることリスト（この会話だけで組み立て直す） ──
  const todayYmd = new Date(now + 9 * H).toISOString().slice(0, 10);
  const todo = buildStaffTodoList({
    atMs: now,
    conversations: [{ id: input.conv.id, customer_name: input.conv.customer_name, account: input.conv.account ?? null, status: input.conv.status, is_post_apply: input.conv.is_post_apply, ...(input.reapply?.reapply ? { reapply: true } : {}), ...(parallelSecond === true ? { parallelSecond: true } : {}) }],
    aixItems: input.aixItems.filter((i) => ms(i.created_at) <= now),
    promises: input.calendarEvents.filter((e) => (e.notes ?? "").startsWith(PROMISE_MUST_MARK) && ms(e.created_at) <= now),
    facts: (s.recordedFacts ?? []).filter((f) => f.status === "done").map((f) => ({ conversation_id: input.conv.id, kind: f.kind, sent_at: f.sent_at, detail: (f.detail ?? null) as { object?: string | null; checkPattern?: string | null } | null })),
    viewings: s.viewingHistory.filter((v) => v.scheduled_date === todayYmd).map((v, i) => ({ id: i, conversation_id: input.conv.id, scheduled_date: v.scheduled_date, scheduled_time: v.scheduled_time ?? null, status: v.status ?? null, property_name: v.property_name ?? null, actual_date: v.actual_date ?? null })),
    messages: s.messages.filter((m) => now - ms(m.createdAt) <= 49 * H && ms(m.createdAt) <= now).map((m) => ({ conversation_id: input.conv.id, sender: m.sender, text: m.text, created_at: m.createdAt })),
    customerTurns: s.messages.filter((m) => m.sender === "customer").map((m) => ({ conversation_id: input.conv.id, created_at: m.createdAt })),
  });
  const todoItems = todo.customers.flatMap((c) => c.items).filter((it) => !it.doneAt);

  // ── 物件 ──
  const lastSent = (s.recordedFacts ?? []).filter((f) => f.kind === "properties_sent" && f.status === "done").map((f) => ms(f.sent_at)).filter(Number.isFinite);
  const pickupReady = pickupReadyAt(input.pickups, now, lastSent.length ? Math.max(...lastSent) : NaN);
  const pickupsPending = input.pickups.filter((p) => !p.sent_at && p.status !== "misattributed" && !(p.expired_at && ms(p.expired_at) <= now)).length;
  const rx = input.reactions ?? null;
  const reactions = rx ? {
    negatives: rx.negatives.map((n) => `${REACTION_ATTR_JA[n.attr]}${n.ref != null ? `(${n.ref})` : ""}${n.hard ? "!" : ""}`),
    good: Object.values(rx.perProperty).filter((p) => p.good).length,
    declined: Object.values(rx.perProperty).filter((p) => p.declined).length,
  } : null;

  // ── 印 ──
  const sensitive = screeningSensitiveInMessages(s.messages.map((m) => ({ sender: m.sender, text: m.text, isAix: m.isAix })));
  const applyish = !!input.conv.is_post_apply || PARALLEL_STATUSES.has((input.conv.status ?? "").trim());

  // ── 次の一手の候補（今ある決め方の順に並べるだけ・選ぶのは司令塔／ブレイン） ──
  const nextActions: HubNextAction[] = [];
  const nq = nextPromiseAix(steps, { nowMs: now });
  if (nq) nextActions.push({ by: "aix", action: nq.next.action, checkPattern: nq.next.pickerKey ?? nq.next.checkPattern, label: promiseStepLabel(nq.next), dueAt: iso(ms(nq.next.promisedAt) + PROMISE_QUEUE_MAX_AGE_MS), source: "promise_queue" });
  for (const i of input.aixItems) if (i.status === "pending" && ms(i.created_at) <= now) nextActions.push({ by: "aix", action: i.action, checkPattern: i.check_pattern, label: `要対応 ${i.action}${i.check_pattern ? `/${i.check_pattern}` : ""}`, dueAt: iso(ms(i.created_at) + DAY), source: "aix_item" });
  for (const it of todoItems) if (it.source !== "aix_item") nextActions.push({ by: it.source === "unanswered" ? "brain" : it.action ? "aix" : "staff", action: it.action, checkPattern: it.checkPattern, label: it.task.slice(0, 50), dueAt: it.dueAt, source: "todo" });
  if (pickupReady && promises.some((p) => p.source === "queue" && p.kind === "pickup")) nextActions.push({ by: "aix", action: "property_send", checkPattern: null, label: "送れる物件が揃った（ピックアップの約束）", dueAt: null, source: "pickup_ready" });
  if (loc.next) nextActions.push({ by: "brain", action: loc.next.aix[0] ?? null, checkPattern: null, label: loc.next.label, dueAt: null, source: "route" });

  // ── 誰が動くか（決まった順: お客様の番→ブレイン／開いた約束・要対応→AIX／予定→スタッフ） ──
  let actor: CustomerHub["actor"] = { who: "none", why: "開いている物なし", dueAt: null };
  const unanswered = todoItems.find((t) => t.source === "unanswered");
  const terminal = state?.stage === "dropped" || state?.stage === "won";
  if (turn.customerTurnAt && !terminal) actor = { who: "brain", why: "お客様の番（未返信）", dueAt: unanswered?.dueAt ?? iso(ms(turn.customerTurnAt) + H) };
  else if (nextActions.some((a) => a.source === "promise_queue" || a.source === "aix_item" || a.source === "pickup_ready")) {
    const a = nextActions.find((x) => x.source === "promise_queue" || x.source === "aix_item" || x.source === "pickup_ready")!;
    actor = { who: "aix", why: a.label, dueAt: a.dueAt };
  } else if (todoItems.length) actor = { who: "staff", why: todoItems[0].task.slice(0, 50), dueAt: todoItems[0].dueAt };
  else if (loc.branch === "silent") actor = { who: "brain", why: "音信不通（追客）", dueAt: null };
  if (sensitive && actor.who !== "none") actor = { ...actor, why: `${actor.why}・審査の事情あり（生成は Claude だけ）` };

  return {
    conversationId: input.conv.id,
    atIso: iso(now),
    where: {
      stage: state?.stage ?? null, stageLabel: state ? STAGE_LABEL[state.stage] : null, since: state?.since ?? null,
      node: loc.node, nodeName: loc.node ? ROUTE_NODES[loc.node].name : null, branch: loc.branch, branchName: loc.branch ? ROUTE_BRANCHES[loc.branch].name : null,
      next: loc.next, wayBack: loc.wayBack, evidence: loc.evidence, statusRaw: input.conv.status, isPostApply: !!input.conv.is_post_apply,
    },
    promises: promises.sort((a, b) => ms(a.promisedAt) - ms(b.promisedAt)),
    promisesDone: steps.filter((x) => x.status === "done").length,
    nextActions,
    schedule,
    properties: {
      sentCount: ledger.facts.propertiesSentCount,
      rooms: (state?.properties ?? []).map((r) => ({ name: r.name, status: r.status, estimateSent: r.estimateSent, customerInterest: r.customerInterest })),
      focus: state?.properties.find((r) => r.key === state?.focusKey)?.name ?? null,
      pickupsPending, pickupReady, reactions,
    },
    flags: {
      reapply: !!input.reapply?.reapply, reapplyPattern: input.reapply?.reapply ? RETURN_PATTERN_SHORT[input.reapply.pattern] : null,
      parallelSecond, screeningSensitive: sensitive, claudeOnly: !!sensitive || parallelSecond === true || (parallelSecond === null && applyish), searching: state?.searching ?? null,
    },
    actor,
    stateConflicts: state?.conflicts ?? [],
    todo: todoItems,
  };
}

// ───────── 食い違い（元どうしが違う事を言っている所＝司令塔が決める所） ─────────
export type HubContradictionType =
  | "pickup_promise_vs_viewing"     // ピックアップの約束が開いているのに、内覧が決まっている（内覧の物件で進むのか・探し続けるのか）
  | "status_vs_stage"               // 状態（審査管理の同期・手で変えた status）と、一次事実から決めた段階が違う
  | "aix_item_open_promise_done"    // 要対応（AIX）が開いたまま、同じ約束はもう果たした
  | "calendar_open_promise_done"    // カレンダーの【必ず】が開いたまま、同じ AIX の約束はもう果たした
  | "open_after_closed"             // 見送り・成約なのに、約束・要対応が開いている
  | "calendar_viewing_vs_state"     // カレンダーの内覧の予定と、customer-state の内覧（viewing_history・本文）が合わない
  | "watch_but_pickup_ready"        // 新着待ち（探し続ける約束）なのに、送れる物件が揃って送っていない
  | "contact_overdue"               // 連絡日が過ぎたのに、こちらから連絡していない
  | "reapply_still_post_apply"      // 申込歴あり（戻した）なのに、状態は申込以降のまま
  | "state_conflict";               // customer-state が見つけたずれ（warn の物）
export const HUB_CONTRADICTION_JA: Record<HubContradictionType, string> = {
  pickup_promise_vs_viewing: "ピックアップの約束が開いたまま内覧が決まっている",
  status_vs_stage: "状態（status）と一次事実の段階が違う",
  aix_item_open_promise_done: "要対応が開いたまま約束は果たした",
  calendar_open_promise_done: "【必ず】が開いたまま約束は果たした",
  open_after_closed: "見送り・成約なのに約束・要対応が開いている",
  calendar_viewing_vs_state: "カレンダーの内覧と状態の内覧が合わない",
  watch_but_pickup_ready: "新着待ちなのに送れる物件が揃っている",
  contact_overdue: "連絡日を過ぎてこちらから連絡していない",
  reapply_still_post_apply: "申込歴あり（戻した）なのに状態は申込以降",
  state_conflict: "customer-state のずれ",
};
export type HubContradiction = { type: HubContradictionType; detail: string };
/** 要対応の見分けの札（食い違いの detail の頭・link-hub-brain が「果たした要対応」を外すのに使う） */
export function aixItemKey(action: string | null | undefined, checkPattern: string | null | undefined, createdAt: string): string {
  return `${action ?? ""}${checkPattern ? `/${checkPattern}` : ""} 立った ${createdAt.slice(5, 16)}`;
}

const POST_STAGES = new Set<CustomerStage>(["applying", "won"]);
const jstYmdOf = (n: number) => new Date(n + 9 * H).toISOString().slice(0, 10);

export function hubContradictions(hub: CustomerHub, input: HubInput): HubContradiction[] {
  const out: HubContradiction[] = [];
  const now = input.nowMs;
  const stage = hub.where.stage;
  const upcomingViewings = hub.schedule.filter((x) => x.kind === "viewing" && x.source === "customer_state" && !x.done && ms(x.at) >= now - DAY);
  const queueOpen = hub.promises.filter((p) => p.source === "queue");

  if (queueOpen.some((p) => p.kind === "pickup" && !p.watch) && upcomingViewings.length) out.push({ type: "pickup_promise_vs_viewing", detail: `内覧 ${upcomingViewings[0].at.slice(5, 10)}・ピックアップの約束 ${queueOpen.find((p) => p.kind === "pickup")!.promisedAt.slice(5, 10)}` });

  if (stage && hub.where.statusRaw) {
    const statusPre = isPreApplyForNudge(hub.where.statusRaw);
    const stagePost = POST_STAGES.has(stage);
    if (statusPre === stagePost && stage !== "dropped") out.push({ type: "status_vs_stage", detail: `status=${hub.where.statusRaw} 段階=${stage}` });
  }

  const steps = buildPromiseQueue(toQueueMsgs(input.state), toQueueLogs(input.state), now, { windowDays: 14 });
  const doneAfter = (action: string | null, cp: string | null, afterMs: number) => steps.find((st) => st.status === "done" && st.doneBy?.startsWith("AIX") && st.action === action
    && (!cp || !st.checkPattern || st.checkPattern === cp) && ms(st.doneAt) >= afterMs - 60_000
    // 約束した送信そのもの（約束と同じ1通で done と数えた物）は「果たした」に入れない（実データ: 物件送付の1通に「新着が出たら送る」→ 同じ時刻で done）
    && ms(st.doneAt) > ms(st.promisedAt) + 60_000);
  for (const i of input.aixItems) {
    if (i.status !== "pending" || ms(i.created_at) > now) continue;
    const d = doneAfter(i.action, i.check_pattern, ms(i.created_at));
    if (d) out.push({ type: "aix_item_open_promise_done", detail: `${aixItemKey(i.action, i.check_pattern, i.created_at)}・果たした ${String(d.doneAt).slice(5, 16)}` });
  }
  for (const e of input.calendarEvents) {
    if (e.is_done || !(e.notes ?? "").startsWith(PROMISE_MUST_MARK) || isContactPromiseNotes(e.notes)) continue;
    const action = promiseAixActionOf(e.event_type);
    if (!action) continue;
    const d = doneAfter(action, promiseCheckPatternOf(e.notes), ms(e.created_at));
    if (d) out.push({ type: "calendar_open_promise_done", detail: `${e.event_type} 立った ${e.created_at.slice(5, 16)}・果たした ${String(d.doneAt).slice(5, 16)}` });
  }

  if (stage === "dropped" || stage === "won") {
    const open = queueOpen.filter((p) => !p.watch).length + input.aixItems.filter((i) => i.status === "pending").length;
    if (open) out.push({ type: "open_after_closed", detail: `段階=${stage} 開いている ${open}` });
  }

  const calViewings = input.calendarEvents.filter((e) => e.event_type === "viewing" && !e.is_done && !/^\s*【時間確保】/.test(e.notes ?? "") && ms(e.start_at) >= now - 12 * H);
  const stateYmds = new Set(upcomingViewings.map((v) => v.at.slice(0, 10)));
  for (const e of calViewings) {
    const ymd = jstYmdOf(ms(e.start_at));
    if (!stateYmds.has(ymd)) out.push({ type: "calendar_viewing_vs_state", detail: `カレンダー ${ymd}・状態 ${[...stateYmds].join(",") || "内覧なし"}` });
  }

  if (hub.flags.searching?.reason === "watch_promised" && hub.properties.pickupReady) out.push({ type: "watch_but_pickup_ready", detail: `送れる物件 ${hub.properties.pickupsPending}` });

  for (const p of hub.promises) {
    if (p.source !== "contact" || !p.dueAt || ms(p.dueAt) + DAY > now) continue;
    const contacted = input.state.messages.some((m) => m.sender !== "customer" && ms(m.createdAt) >= ms(p.dueAt));
    if (!contacted) out.push({ type: "contact_overdue", detail: `${p.label}` });
  }

  if (hub.flags.reapply && stage && POST_STAGES.has(stage)) out.push({ type: "reapply_still_post_apply", detail: `段階=${stage}` });

  for (const c of hub.stateConflicts) if (c.severity === "warn") out.push({ type: "state_conflict", detail: c.code });
  return out;
}

// ───────── 表示（伏せる） ─────────
export function renderCustomerHub(hub: CustomerHub, o: { customerName?: string | null; contradictions?: HubContradiction[] } = {}): string {
  const m = (t: string | null | undefined) => maskPII(String(t ?? ""), [o.customerName ?? null]).replace(/\s+/g, " ").slice(0, 70);
  const L: string[] = [];
  const w = hub.where;
  L.push(`■ ${hub.conversationId.slice(0, 8)} @${hub.atIso.slice(0, 16)}`);
  L.push(`今どこ: ${w.stageLabel ?? "?"}（status=${w.statusRaw ?? "-"}${w.isPostApply ? "・申込以降の印" : ""}）→ 地図 ${w.nodeName ?? "-"}${w.branchName ? `／分かれ道 ${w.branchName}` : ""}`);
  if (w.next) L.push(`  地図の次の一手: ${w.next.label}${w.next.aix.length ? `［${w.next.aix.join("/")}］` : ""}`);
  if (w.wayBack) L.push(`  本線への戻り: →${w.wayBack.to ?? "?"} ${w.wayBack.how}`);
  L.push(`約束（開いている ${hub.promises.length}・果たした ${hub.promisesDone}）:`);
  for (const p of hub.promises.slice(0, 12)) L.push(`  - [${p.source}] ${p.label}${p.pickerKey ? ` 鍵=${p.pickerKey}` : ""}${p.dueAt ? ` 期限 ${p.dueAt.slice(5, 16)}` : ""}${p.overdue ? " ⚠過ぎ" : ""}${p.watch ? " (新着待ち)" : ""}${p.evidence ? `「${m(p.evidence)}」` : ""}`);
  L.push(`次の一手の候補:`);
  for (const a of hub.nextActions.slice(0, 8)) L.push(`  - ${a.by} ${a.action ?? "返信"}${a.checkPattern ? `/${a.checkPattern}` : ""} ${m(a.label)}${a.dueAt ? ` 期限 ${a.dueAt.slice(5, 16)}` : ""}（${a.source}）`);
  L.push(`予定:`);
  for (const x of hub.schedule.slice(-8)) L.push(`  - ${x.at.slice(0, 16)} ${x.kind} ${m(x.label)}${x.done ? " 済" : ""}（${x.source}）`);
  const p = hub.properties;
  L.push(`物件: 送った ${p.sentCount}・お部屋 ${p.rooms.length}（${p.rooms.slice(0, 4).map((r) => r.status).join("・")}）・未送付ピックアップ ${p.pickupsPending}${p.pickupReady ? "（送れる）" : ""}${p.reactions ? `・反応 ×${p.reactions.declined} ○${p.reactions.good} [${p.reactions.negatives.join(",")}]` : ""}`);
  const f = hub.flags;
  L.push(`印: ${[f.reapply ? `申込歴あり(${f.reapplyPattern})` : "", f.parallelSecond ? PARALLEL_2ND_LABEL : f.parallelSecond === null ? "2番手か読めない→Claudeだけ" : "", f.screeningSensitive ? `審査の事情(${f.screeningSensitive.category})→Claudeだけ` : "", f.searching?.active ? `探し中(${f.searching.reason})` : ""].filter(Boolean).join("・") || "なし"}`);
  L.push(`誰が動く: ${hub.actor.who}（${m(hub.actor.why)}）${hub.actor.dueAt ? ` 期限 ${hub.actor.dueAt.slice(5, 16)}` : ""}`);
  if (o.contradictions?.length) { L.push(`食い違い:`); for (const c of o.contradictions) L.push(`  - ${HUB_CONTRADICTION_JA[c.type]}: ${m(c.detail)}`); }
  return L.join("\n");
}
