// app/lib/viewing-cancel-calendar-server.ts（サーバー専用・画面から import しない）
// お客様が決まった内覧を取りやめた時に、カレンダーの予定と申込ツールのカレンダーの行を消す。判定は viewing-cancel-calendar.ts（純関数）。
//
// 2026-09-30 竹内さん: 呼ぶのはブレインが内覧の流れを解いた所（brain-core）。応答は待たせない（after）。
//   二重に走っても同じ結果（もう無ければ何もしない）。消す前の行の中身を calendar_event_deletions に残してから消す
//   （残せなかった時は消さない＝戻せない削除をしない）。VIEWING_CANCEL_AUTO=off で止まる
import { createClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { LedgerInput } from "./action-ledger";
import { screeningTaskIdFor, isValidSyncKey } from "./screening-calendar-sync";
import { decideViewingCancelFromLedgerInput, pickViewingEventsToCancel, viewingCancelAutoEnabled, type CalEventRow } from "./viewing-cancel-calendar";

/** 申込ツールのカレンダーの行（この予定から入れた dt_sumora_cal_<id>）を消す。/api/daily-tasks の DELETE ?sync_key= と同じ処理。鍵が無い環境では何もしない */
export async function deleteScreeningTaskBySyncKey(key: string | number): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  if (!isValidSyncKey(key)) return { ok: false, error: "invalid sync_key" };
  const url = process.env.SCREENING_ADMIN_SUPABASE_URL; const anon = process.env.SCREENING_ADMIN_SUPABASE_ANON_KEY;
  if (!url || !anon) return { ok: false, skipped: "no_screening_env" };
  const { error } = await createClient(url, anon).from("daily_tasks").delete().eq("id", screeningTaskIdFor(key));
  return error ? { ok: false, error: error.message } : { ok: true };
}

export type CancelRunResult = { action: "deleted" | "none" | "off" | "kept"; why?: string; deleted?: Array<number | string>; candidates?: Array<number | string> };

/**
 * ブレインの台帳の入力（今回の連投まで）から、今回の連投で決まった内覧が取りやめになったかを決め、なっていれば予定を消す。
 *   ledgerInput … brain-core が台帳を作った時と同じ入力（messages は古い順）
 *   dryRun      … 消さずに、消す対象だけ返す（監査・テスト用）
 */
export async function cancelViewingCalendarOnCustomerCancel(o: { conversationId: string; ledgerInput: LedgerInput; nowMs?: number; dryRun?: boolean }): Promise<CancelRunResult> {
  const now = o.nowMs ?? o.ledgerInput.now ?? Date.now();
  const d = decideViewingCancelFromLedgerInput(o.ledgerInput, now);
  if (!d.cancel) return { action: "none", why: d.why };
  if (!o.dryRun && !viewingCancelAutoEnabled()) { console.log(JSON.stringify({ tag: "viewing-cancel:off", conversationId: o.conversationId, day: d.day })); return { action: "off" }; }

  const { data, error } = await supabase.from("calendar_events")
    .select("id, conversation_id, event_type, title, customer_name, start_at, end_at, all_day, notes, is_done, created_at")
    .eq("conversation_id", o.conversationId).eq("event_type", "viewing").eq("is_done", false).limit(50);
  if (error) { console.error(JSON.stringify({ tag: "viewing-cancel:failed", conversationId: o.conversationId, step: "select", error: error.message })); return { action: "none", why: "select_failed" }; }
  const events = (data ?? []) as CalEventRow[];
  const pick = pickViewingEventsToCancel({ events, conversationId: o.conversationId, day: d.day, time: d.time, nowMs: now });
  const trigger = d.triggerText;
  if (pick.deleteIds.length === 0) {
    // もう消してある（二重に走った）・予定が無い・決まらない → 何もしない。決まらない時だけ人が気付けるようログに残す
    if (pick.why !== "no_candidate") console.log(JSON.stringify({ tag: "viewing-cancel:kept", conversationId: o.conversationId, why: pick.why, day: d.day, time: d.time, candidates: pick.candidates }));
    return { action: pick.why === "no_candidate" ? "none" : "kept", why: pick.why, candidates: pick.candidates };
  }
  if (o.dryRun) return { action: "deleted", deleted: pick.deleteIds, candidates: pick.candidates };

  const deleted: Array<number | string> = [];
  for (const id of pick.deleteIds) {
    const row = events.find((e) => e.id === id)!;
    // 消す前の中身を残す（戻す時はこの event_row を calendar_events に入れ直す）。残せなければ消さない
    const { error: logErr } = await supabase.from("calendar_event_deletions").insert({
      event_id: String(id), conversation_id: o.conversationId, reason: "customer_cancelled_after_confirm",
      trigger_text: trigger, trigger_at: d.triggerAt, event_row: row,
    });
    if (logErr) { console.error(JSON.stringify({ tag: "viewing-cancel:failed", conversationId: o.conversationId, step: "record", eventId: id, error: logErr.message })); continue; }
    const { error: delErr } = await supabase.from("calendar_events").delete().eq("id", id).eq("conversation_id", o.conversationId).eq("is_done", false);
    if (delErr) { console.error(JSON.stringify({ tag: "viewing-cancel:failed", conversationId: o.conversationId, step: "delete", eventId: id, error: delErr.message })); continue; }
    const scr = await deleteScreeningTaskBySyncKey(id).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    deleted.push(id);
    console.log(JSON.stringify({ tag: "viewing-cancel:deleted", conversationId: o.conversationId, eventId: id, day: d.day, time: d.time, startAt: row.start_at, trigger: trigger.slice(0, 120), screening: scr }));
  }
  return { action: deleted.length > 0 ? "deleted" : "none", deleted, candidates: pick.candidates, why: deleted.length > 0 ? undefined : "record_or_delete_failed" };
}
