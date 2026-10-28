// app/lib/viewing-done-after-greeting-server.ts — #5 の DB の所（viewing-done-after-greeting.ts の決め方で済みにする）
import { createClient } from "@supabase/supabase-js";
import { supabase } from "./supabase-server";
import { screeningAdminSupabaseKey } from "./supabase-server-key";
import { screeningTaskIdFor, isValidSyncKey } from "./screening-calendar-sync";
import { pickViewingEventsDoneAfterGreeting, type ViewingEventRow } from "./viewing-done-after-greeting";

export async function markViewingDoneAfterGreeting(conversationId: string, nowMs: number = Date.now()): Promise<{ done: Array<number | string>; screening: number; error?: string }> {
  const since = new Date(nowMs - 24 * 3600_000).toISOString();
  const { data, error } = await supabase.from("calendar_events").select("id, event_type, start_at, is_done")
    .eq("conversation_id", conversationId).eq("event_type", "viewing").eq("is_done", false).gte("start_at", since).limit(20);
  if (error) return { done: [], screening: 0, error: error.message };
  const ids = pickViewingEventsDoneAfterGreeting((data ?? []) as ViewingEventRow[], nowMs);
  if (!ids.length) return { done: [], screening: 0 };
  const { error: upErr } = await supabase.from("calendar_events").update({ is_done: true }).in("id", ids);
  if (upErr) return { done: [], screening: 0, error: upErr.message };
  // 申込ツールのカレンダーの行（この予定から入れた dt_sumora_cal_<id>）も済みに。鍵が無い環境・行が無い時は何もしない
  let screening = 0;
  const url = process.env.SCREENING_ADMIN_SUPABASE_URL; const key = screeningAdminSupabaseKey();
  if (url && key) {
    const sids = ids.filter(isValidSyncKey).map((id) => screeningTaskIdFor(id));
    if (sids.length) {
      const { data: up, error: sErr } = await createClient(url, key).from("daily_tasks").update({ done: true }).in("id", sids).select("id");
      if (!sErr) screening = (up ?? []).length;
    }
  }
  return { done: ids, screening };
}
