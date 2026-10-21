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
    return await pageAll<TodoMarkRow>((a, b) => sb.from("staff_todo_marks").select("item_key, conversation_id, marked_at")
      .gte("marked_at", sinceIso).lte("marked_at", atIso).order("marked_at").range(a, b));
  } catch (e) {
    console.warn("[staff-todo] staff_todo_marks:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

/** atMs の時点の材料（過去の日も同じ読み方で組み立て直せる＝その時点で開いていた物を作成・完了の時刻で選ぶ） */
export async function loadStaffTodoInput(sb: SupabaseClient, atMs: number = Date.now()): Promise<TodoInput> {
  const atIso = new Date(atMs).toISOString();
  const since30 = new Date(atMs - 30 * DAY).toISOString();
  const since60 = new Date(atMs - 60 * DAY).toISOString();
  const msgSince = new Date(atMs - 49 * 3600_000).toISOString();
  const todayYmd = new Date(atMs + JST_OFFSET_MS).toISOString().slice(0, 10);

  const [aixRows, promiseRows, viewings, messageRows, marks] = await Promise.all([
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
  ]);
  if (viewings.error) throw new Error(viewings.error.message);
  const viewingRows = (viewings.data ?? []) as TodoViewingRow[];

  const convIds = new Set<string>();
  for (const r of aixRows) convIds.add(r.conversation_id);
  for (const r of promiseRows) if (r.conversation_id) convIds.add(r.conversation_id);
  for (const r of viewingRows) if (r.conversation_id) convIds.add(r.conversation_id);
  for (const r of messageRows) convIds.add(r.conversation_id);
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
  const CH = 100;
  for (let i = 0; i < Math.max(ids.length, factConv.length, promiseConv.length); i += CH) {
    const [c, f, m] = await Promise.all([
      ids.length > i ? pageAll<TodoConversation & ReapplyConvRow>((a, b) => sb.from("conversations").select("id, customer_name, account, status, is_post_apply, status_manual_back_at, deepseek_cutoff_at")
        .in("id", ids.slice(i, i + CH)).order("id").range(a, b)) : Promise.resolve([]),
      factConv.length > i ? pageAll<TodoFactRow>((a, b) => sb.from("sent_facts").select("conversation_id, kind, sent_at, detail")
        .in("conversation_id", factConv.slice(i, i + CH)).eq("status", "done").gte("sent_at", since60).order("sent_at").order("id").range(a, b)) : Promise.resolve([]),
      promiseConv.length > i ? pageAll<TodoCustomerTurnRow>((a, b) => sb.from("messages").select("conversation_id, created_at")
        .in("conversation_id", promiseConv.slice(i, i + CH)).eq("sender", "customer").gte("created_at", since60).lte("created_at", atIso)
        .order("created_at").order("id").range(a, b)) : Promise.resolve([]),
    ]);
    // 2026-10-21 竹内さんの決定（70193195）: 申込歴あり（再探し）を付ける（読めなければ付けないだけ・reapply-customer-server）
    const re = await loadReapplyStates(sb, c as ReadonlyArray<ReapplyConvRow>);
    conversations.push(...(c as TodoConversation[]).map((row): TodoConversation => ({
      id: row.id, customer_name: row.customer_name, account: row.account, status: row.status, is_post_apply: row.is_post_apply, ...(re.has(row.id) ? { reapply: true } : {}),
    })));
    facts.push(...f);
    customerTurns.push(...m);
  }

  return { atMs, conversations, facts, customerTurns, marks, aixItems: aixRows, promises: promiseRows, viewings: viewingRows, messages: messageRows };
}

export async function loadStaffTodoList(sb: SupabaseClient, atMs: number = Date.now()): Promise<TodoList> {
  return buildStaffTodoList(await loadStaffTodoInput(sb, atMs));
}
