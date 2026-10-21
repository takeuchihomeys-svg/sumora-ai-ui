// app/lib/staff-todo-list-server.ts — 【やることリスト】の材料を DB から読む（読むだけ・書かない・LLM なし）。組み立ては staff-todo-list.ts
//   ⚠ PostgREST は1回 1000行まで（limit を大きくしても切れる）→ 多くなり得る読みは pageAll で 1000行ずつ読む
import type { SupabaseClient } from "@supabase/supabase-js";
import { JST_OFFSET_MS } from "@/app/lib/jst-date";
import { PROMISE_MUST_MARK } from "@/app/lib/promise-calendar";
import {
  buildStaffTodoList, type TodoInput, type TodoList, type TodoAixItemRow, type TodoPromiseRow, type TodoFactRow,
  type TodoViewingRow, type TodoMessageRow, type TodoConversation, type TodoMarkRow, type TodoCustomerTurnRow,
} from "@/app/lib/staff-todo-list";
import { loadReapplyStates, type ReapplyConvRow } from "@/app/lib/reapply-customer-server";
import { type TodoTargetRow, type TodoDeliveryRow, type OtherConvRow, type OtherPcRow, todoTargetMergeEnabled, todoSonotaMergeEnabled, pickOtherDaily } from "@/app/lib/staff-todo-list";
import type { TodoConditionRow } from "@/app/lib/staff-todo-instruction";
import type { TodoPrioritySignal } from "@/app/lib/staff-todo-priority";
import { loadBrainTargets, loadScreeningList, type BrainTarget, type ScreeningRow } from "@/app/lib/brain-attention-server";
import { PROPERTY_DELIVERY_AIX } from "@/app/lib/aix-task-link";
import { getCustomerHub } from "@/app/lib/customer-hub-server";
import { MAIN_ROUTE, type RouteNodeId } from "@/app/lib/apply-route-map";

const DAY = 86_400_000;
const PAGE = 1000;

type PageQuery = (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
/** 1000行ずつ最後まで（上限 maxRows） */
async function pageAll<T>(q: PageQuery, maxRows = 20_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** グループの✅（staff_todo_marks）。表がまだ無い（scripts/staff-todo-marks-migration.sql を流す前）は空で動く */
export async function loadStaffTodoMarks(sb: SupabaseClient, sinceIso: string, atIso: string): Promise<TodoMarkRow[]> {
  try {
    return await pageAll<TodoMarkRow>((a, b) => sb.from("staff_todo_marks").select("item_key, conversation_id, marked_at, via")
      .gte("marked_at", sinceIso).lte("marked_at", atIso).order("marked_at").range(a, b));
  } catch (e) {
    console.warn("[staff-todo] staff_todo_marks:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

/** 読み方の切替 */
export type StaffTodoLoadOptions = {
  /** 🌟ターゲットをまとめる（既定 todoTargetMergeEnabled()） */
  mergeTargets?: boolean;
  /** 【その他 本日のリスト】をまとめる（既定 todoSonotaMergeEnabled()） */
  mergeSonota?: boolean;
  /** 並びの点にお客様ごとのハブ（customer-hub）を使う（既定 staffTodoHubScoreEnabled()） */
  hubScore?: boolean;
  /** ハブを読む時間の上限（ms・過ぎた分は行と状態から数える） */
  hubBudgetMs?: number;
};
/**
 * 並びの点にお客様ごとのハブ（customer-hub・地図の駅・申込歴あり・反応）を使うか（既定 on）。
 *   1人ずつ読むので時間の上限（STAFF_TODO_HUB_BUDGET_MS・既定 20秒）を過ぎた分は行と状態から数える。戻す: STAFF_TODO_HUB_SCORE=off
 */
export function staffTodoHubScoreEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.STAFF_TODO_HUB_SCORE ?? "").trim().toLowerCase() !== "off";
}

/** atMs の時点の材料（過去の日も同じ読み方で組み立て直せる＝その時点で開いていた物を作成・完了の時刻で選ぶ。ターゲットは今の判断） */
export async function loadStaffTodoInput(sb: SupabaseClient, atMs: number = Date.now(), opts: StaffTodoLoadOptions = {}): Promise<TodoInput> {
  const atIso = new Date(atMs).toISOString();
  const since30 = new Date(atMs - 30 * DAY).toISOString();
  const since60 = new Date(atMs - 60 * DAY).toISOString();
  const since180 = new Date(atMs - 180 * DAY).toISOString();
  const since2d = new Date(atMs - 2 * DAY).toISOString();
  const msgSince = new Date(atMs - 49 * 3600_000).toISOString();
  const todayYmd = new Date(atMs + JST_OFFSET_MS).toISOString().slice(0, 10);
  const mergeTargets = opts.mergeTargets ?? todoTargetMergeEnabled();
  const mergeSonota = opts.mergeSonota ?? todoSonotaMergeEnabled();

  const [aixRows, promiseRows, viewings, messageRows, marks, brainTargets, screeningRows] = await Promise.all([
    pageAll<TodoAixItemRow>((a, b) => sb.from("aix_action_items")
      .select("id, conversation_id, customer_name, action, check_pattern, status, created_at, updated_at, done_at, done_aix_type, done_by, resolution_note")
      .lte("created_at", atIso).gte("created_at", since30).order("created_at", { ascending: false }).order("id").range(a, b), 5000),
    pageAll<TodoPromiseRow>((a, b) => sb.from("calendar_events")
      .select("id, conversation_id, customer_name, event_type, start_at, created_at, notes, is_done")
      .like("notes", `${PROMISE_MUST_MARK}%`).lte("created_at", atIso).gte("created_at", since60).order("id").range(a, b), 5000),
    sb.from("viewing_history")
      .select("id, conversation_id, scheduled_date, scheduled_time, status, property_name, actual_date, viewing_report_at")
      .eq("scheduled_date", todayYmd).limit(200),
    // 新しい順（上限で切れても最新のこちらの返信を落とさない＝誤って「未返信」にしない・並べ直しは組み立て側）
    pageAll<TodoMessageRow>((a, b) => sb.from("messages")
      .select("conversation_id, sender, text, created_at")
      .gte("created_at", msgSince).lte("created_at", atIso).order("created_at", { ascending: false }).range(a, b), 10_000),
    loadStaffTodoMarks(sb, since60, atIso),
    // 🌟ターゲット（announce-hot-customers と同じ読み方・同じ人数の上限）。読めなければターゲット無しで動く
    mergeTargets || mergeSonota ? loadBrainTargets(sb as Parameters<typeof loadBrainTargets>[0]).catch((e) => { console.warn("[staff-todo] targets:", e instanceof Error ? e.message : String(e)); return [] as BrainTarget[]; }) : Promise.resolve([] as BrainTarget[]),
    mergeTargets ? loadScreeningList(sb as Parameters<typeof loadScreeningList>[0]).catch(() => [] as ScreeningRow[]) : Promise.resolve([] as ScreeningRow[]),
  ]);
  if (viewings.error) throw new Error(viewings.error.message);
  const viewingRows = (viewings.data ?? []) as TodoViewingRow[];
  const targets: TodoTargetRow[] = mergeTargets ? pickTargets(brainTargets) : [];
  // 【その他 本日のリスト】（announce-sonota と同じ選び方）の上位を⑤その他の新着確認に。ターゲット全員（人数の上限で切った人も）は除く
  if (mergeSonota) {
    const others = await loadOtherDaily(sb, new Set(brainTargets.map((x) => x.conversationId)), atMs).catch((e) => { console.warn("[staff-todo] sonota:", e instanceof Error ? e.message : String(e)); return [] as TodoTargetRow[]; });
    targets.push(...others);
  }

  const convIds = new Set<string>();
  for (const r of aixRows) convIds.add(r.conversation_id);
  for (const r of promiseRows) if (r.conversation_id) convIds.add(r.conversation_id);
  for (const r of viewingRows) if (r.conversation_id) convIds.add(r.conversation_id);
  for (const r of messageRows) convIds.add(r.conversation_id);
  for (const r of targets) convIds.add(r.conversationId);
  const ids = [...convIds];

  // 履行の送信（AIX 要対応・約束・内覧のある会話・60日）と、約束のある会話のお客様の発言の時刻（条件待ちの見分け）
  const factConv = [...new Set([
    ...aixRows.map((r) => r.conversation_id),
    ...promiseRows.map((p) => p.conversation_id).filter((x): x is string => !!x),
    ...viewingRows.map((v) => v.conversation_id).filter((x): x is string => !!x),
  ])];
  const promiseConv = [...new Set(promiseRows.map((p) => p.conversation_id).filter((x): x is string => !!x))];
  const facts: TodoFactRow[] = [];
  const conversations: TodoConversation[] = [];
  const customerTurns: TodoCustomerTurnRow[] = [];
  const pcByConv = new Map<string, string>();
  const everSent = new Set<string>();
  const deliveries: TodoDeliveryRow[] = [];
  const CH = 100;
  for (let i = 0; i < Math.max(ids.length, factConv.length, promiseConv.length); i += CH) {
    const idChunk = ids.slice(i, i + CH);
    const [c, f, m, sent, aixDeliv] = await Promise.all([
      idChunk.length ? pageAll<TodoConversation & ReapplyConvRow & { property_customer_id: string | null }>((a, b) => sb.from("conversations")
        .select("id, customer_name, account, status, is_post_apply, status_manual_back_at, deepseek_cutoff_at, created_at, property_customer_id")
        .in("id", idChunk).order("id").range(a, b)) : Promise.resolve([]),
      factConv.length > i ? pageAll<TodoFactRow>((a, b) => sb.from("sent_facts").select("conversation_id, kind, sent_at, detail")
        .in("conversation_id", factConv.slice(i, i + CH)).eq("status", "done").gte("sent_at", since60).order("sent_at").order("id").range(a, b)) : Promise.resolve([]),
      promiseConv.length > i ? pageAll<TodoCustomerTurnRow>((a, b) => sb.from("messages").select("conversation_id, created_at")
        .in("conversation_id", promiseConv.slice(i, i + CH)).eq("sender", "customer").gte("created_at", since60).lte("created_at", atIso)
        .order("created_at").order("id").range(a, b)) : Promise.resolve([]),
      // 物件を送った事実（新規の問い合わせ・初回／新着まとめの見分け・新着確認の✅）。180日
      idChunk.length ? pageAll<{ conversation_id: string; sent_at: string }>((a, b) => sb.from("sent_facts").select("conversation_id, sent_at")
        .in("conversation_id", idChunk).eq("kind", "properties_sent").eq("status", "done").gte("sent_at", since180).lte("sent_at", atIso).order("sent_at").order("id").range(a, b)) : Promise.resolve([]),
      idChunk.length ? pageAll<{ conversation_id: string; created_at: string }>((a, b) => sb.from("aix_usage_logs").select("conversation_id, created_at")
        .in("conversation_id", idChunk).in("aix_type", [...PROPERTY_DELIVERY_AIX]).gte("created_at", since2d).lte("created_at", atIso).order("created_at").order("id").range(a, b)) : Promise.resolve([]),
    ]);
    // 2026-10-21 竹内さんの決定（70193195）: 申込歴あり（再探し）を付ける（読めなければ付けないだけ・reapply-customer-server）
    const re = await loadReapplyStates(sb, c as ReadonlyArray<ReapplyConvRow>);
    conversations.push(...c.map((row): TodoConversation => ({
      id: row.id, customer_name: row.customer_name, account: row.account, status: row.status, is_post_apply: row.is_post_apply,
      created_at: row.created_at ?? null, ...(re.has(row.id) ? { reapply: true } : {}),
    })));
    for (const row of c) if (row.property_customer_id) pcByConv.set(row.id, row.property_customer_id);
    facts.push(...f);
    customerTurns.push(...m);
    for (const s of sent) { everSent.add(s.conversation_id); if (Date.parse(s.sent_at) >= Date.parse(since2d)) deliveries.push({ conversation_id: s.conversation_id, at: s.sent_at }); }
    for (const d of aixDeliv) { everSent.add(d.conversation_id); deliveries.push({ conversation_id: d.conversation_id, at: d.created_at }); }
  }

  // お客様の条件の欄（的確な指示の「条件（〇〇駅・〜8万・2LDK）」・欄にある物だけ）
  const conditions: Record<string, TodoConditionRow> = {};
  const pcIds = [...new Set(pcByConv.values())];
  const pcById = new Map<string, TodoConditionRow>();
  for (let i = 0; i < pcIds.length; i += CH) {
    const { data, error } = await sb.from("property_customers").select("id, desired_area, commute_station, commute_minutes, rent_max, floor_plan, other_requests").in("id", pcIds.slice(i, i + CH));
    if (error) { console.warn("[staff-todo] property_customers:", error.message); break; }
    for (const r of (data ?? []) as Array<TodoConditionRow & { id: string }>) pcById.set(r.id, r);
  }
  for (const [cid, pc] of pcByConv) { const r = pcById.get(pc); if (r) conditions[cid] = r; }

  return {
    atMs, conversations, facts, customerTurns, marks, aixItems: aixRows, promises: promiseRows, viewings: viewingRows, messages: messageRows,
    everSent: [...everSent], deliveries, conditions,
    ...(mergeTargets || mergeSonota ? { targets, screening: mergeTargets ? screeningRows.map((r) => r.customerName) : [] } : {}),
  };
}

/** 【その他 本日のリスト】の人（announce-sonota と同じ読み方: 申込前・物件出しの顧客あり・ブロックでない・600件） */
export async function loadOtherDaily(sb: SupabaseClient, targetIds: ReadonlySet<string>, atMs: number): Promise<TodoTargetRow[]> {
  const { data: convs, error } = await sb.from("conversations").select("id, customer_name, property_customer_id, account, line_status")
    .not("status", "in", "(applying,screening,contract,closed_won,closed_lost)").not("property_customer_id", "is", null).neq("line_status", "blocked").limit(600);
  if (error) throw new Error(error.message);
  const rows = (convs ?? []) as OtherConvRow[];
  const pcIds = [...new Set(rows.map((c) => c.property_customer_id).filter((x): x is string => !!x))];
  const pcs: OtherPcRow[] = [];
  for (let i = 0; i < pcIds.length; i += 100) {
    const { data, error: e2 } = await sb.from("property_customers").select("id, customer_name, last_property_sent_at, property_viewed_at, status")
      .in("id", pcIds.slice(i, i + 100)).not("status", "in", "(applying,screening,contract,closed_won,closed_lost)");
    if (e2) throw new Error(e2.message);
    pcs.push(...((data ?? []) as OtherPcRow[]));
  }
  return pickOtherDaily(rows, pcs, targetIds, atMs).rows;
}

/** ターゲットの人数（announce-hot-customers と同じ: 最優先の組 25人・新規／物件検索中 40人） */
export function pickTargets(ts: ReadonlyArray<BrainTarget>): TodoTargetRow[] {
  const top = ts.filter((t) => t.tier === "viewed" || t.tier === "screening_failed" || t.tier === "contact_due").slice(0, 25);
  const rest = ts.filter((t) => t.tier === "new" || t.tier === "engaged").slice(0, 40);
  return [...top, ...rest].map((t) => ({ conversationId: t.conversationId, tier: t.tier, name: t.customerName, lastCustomerAt: t.lastCustomerAt }));
}

/** ハブ（customer-hub）から並びの材料: 地図の駅・申込歴あり・良い反応。時間の上限を過ぎた分は読まない（行と状態から数える） */
export async function loadHubSignals(sb: SupabaseClient, ids: ReadonlyArray<string>, atMs: number, budgetMs: number): Promise<Record<string, TodoPrioritySignal>> {
  const out: Record<string, TodoPrioritySignal> = {};
  const deadline = Date.now() + budgetMs;
  let next = 0;
  const worker = async () => {
    while (next < ids.length && Date.now() < deadline) {
      const id = ids[next++];
      try {
        const r = await getCustomerHub(sb, id, atMs);
        if (!r) continue;
        const node = r.hub.where.node as RouteNodeId | null;
        const idx = node ? MAIN_ROUTE.indexOf(node) : -1;
        out[id] = {
          ...(idx >= 0 ? { routeIndex: idx } : {}),
          ...(r.hub.flags.reapply ? { reapply: true } : {}),
          ...(r.hub.properties.reactions ? { goodReactions: r.hub.properties.reactions.good } : {}),
        };
      } catch (e) { console.warn("[staff-todo] hub:", id.slice(0, 8), e instanceof Error ? e.message : String(e)); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

export async function loadStaffTodoList(sb: SupabaseClient, atMs: number = Date.now(), opts: StaffTodoLoadOptions = {}): Promise<TodoList> {
  const input = await loadStaffTodoInput(sb, atMs, opts);
  const first = buildStaffTodoList(input);
  if (!(opts.hubScore ?? staffTodoHubScoreEnabled())) return first;
  // やる事が残っているお客様（新着確認だけの人は除く）のハブを読み、並びの点に足して組み立て直す
  const ids = first.customers.filter((c) => c.items.some((i) => !i.doneAt && i.source !== "target_new_arrival")).map((c) => c.conversationId);
  if (!ids.length) return first;
  const budget = opts.hubBudgetMs ?? Number(process.env.STAFF_TODO_HUB_BUDGET_MS ?? 20_000);
  const signals = await loadHubSignals(sb, ids, atMs, Number.isFinite(budget) ? budget : 20_000);
  return buildStaffTodoList({ ...input, signals });
}
