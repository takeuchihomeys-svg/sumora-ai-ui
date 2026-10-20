// app/lib/staff-todo-list-server.ts — 【やることリスト】の材料を DB から読む（読むだけ・書かない・LLM なし）。組み立ては staff-todo-list.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { JST_OFFSET_MS } from "@/app/lib/jst-date";
import { PROMISE_MUST_MARK } from "@/app/lib/promise-calendar";
import {
  buildStaffTodoList, type TodoInput, type TodoList, type TodoAixItemRow, type TodoPromiseRow, type TodoFactRow,
  type TodoViewingRow, type TodoMessageRow, type TodoConversation,
} from "@/app/lib/staff-todo-list";

const DAY = 86_400_000;

/** atMs の時点の材料（過去の日も同じ読み方で組み立て直せる＝その時点で開いていた物を作成・完了の時刻で選ぶ） */
export async function loadStaffTodoInput(sb: SupabaseClient, atMs: number = Date.now()): Promise<TodoInput> {
  const atIso = new Date(atMs).toISOString();
  const since30 = new Date(atMs - 30 * DAY).toISOString();
  const since60 = new Date(atMs - 60 * DAY).toISOString();
  const msgSince = new Date(atMs - 49 * 3600_000).toISOString();
  const todayYmd = new Date(atMs + JST_OFFSET_MS).toISOString().slice(0, 10);

  const [aix, promises, viewings, messages] = await Promise.all([
    sb.from("aix_action_items")
      .select("id, conversation_id, customer_name, action, check_pattern, status, created_at, updated_at, done_at, done_aix_type, done_by, resolution_note")
      .lte("created_at", atIso).gte("created_at", since30).order("created_at", { ascending: true }).limit(2000),
    sb.from("calendar_events")
      .select("id, conversation_id, customer_name, event_type, start_at, created_at, notes, is_done")
      .like("notes", `${PROMISE_MUST_MARK}%`).lte("created_at", atIso).gte("created_at", since60).limit(2000),
    sb.from("viewing_history")
      .select("id, conversation_id, scheduled_date, scheduled_time, status, property_name, actual_date, viewing_report_at")
      .eq("scheduled_date", todayYmd).limit(200),
    sb.from("messages")
      .select("conversation_id, sender, text, created_at")
      .gte("created_at", msgSince).lte("created_at", atIso).order("created_at", { ascending: true }).limit(10000),
  ]);
  for (const r of [aix, promises, viewings, messages]) if (r.error) throw new Error(r.error.message);

  const promiseRows = (promises.data ?? []) as TodoPromiseRow[];
  const convIds = new Set<string>();
  for (const r of (aix.data ?? []) as TodoAixItemRow[]) convIds.add(r.conversation_id);
  for (const r of promiseRows) if (r.conversation_id) convIds.add(r.conversation_id);
  for (const r of (viewings.data ?? []) as TodoViewingRow[]) if (r.conversation_id) convIds.add(r.conversation_id);
  for (const r of (messages.data ?? []) as TodoMessageRow[]) convIds.add(r.conversation_id);
  const ids = [...convIds];

  // 約束の済み（履行の送信）は今まで（過去の日の見本でも「後で済んだか」の確かめに使う）
  const promiseConv = [...new Set(promiseRows.filter((p) => p.is_done).map((p) => p.conversation_id).filter((x): x is string => !!x))];
  const facts: TodoFactRow[] = [];
  const conversations: TodoConversation[] = [];
  for (let i = 0; i < Math.max(ids.length, promiseConv.length); i += 150) {
    const [c, f] = await Promise.all([
      ids.length > i ? sb.from("conversations").select("id, customer_name, account, status, is_post_apply").in("id", ids.slice(i, i + 150)) : Promise.resolve({ data: [], error: null }),
      promiseConv.length > i ? sb.from("sent_facts").select("conversation_id, kind, sent_at, detail")
        .in("conversation_id", promiseConv.slice(i, i + 150)).eq("status", "done").gte("sent_at", since60).limit(5000) : Promise.resolve({ data: [], error: null }),
    ]);
    if (c.error) throw new Error(c.error.message);
    if (f.error) throw new Error(f.error.message);
    conversations.push(...((c.data ?? []) as TodoConversation[]));
    facts.push(...((f.data ?? []) as TodoFactRow[]));
  }

  return {
    atMs, conversations, facts,
    aixItems: (aix.data ?? []) as TodoAixItemRow[],
    promises: promiseRows,
    viewings: (viewings.data ?? []) as TodoViewingRow[],
    messages: (messages.data ?? []) as TodoMessageRow[],
  };
}

export async function loadStaffTodoList(sb: SupabaseClient, atMs: number = Date.now()): Promise<TodoList> {
  return buildStaffTodoList(await loadStaffTodoInput(sb, atMs));
}
