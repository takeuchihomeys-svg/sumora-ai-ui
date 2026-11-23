// @ts-nocheck
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { calendarDonePatch } from "@/app/lib/calendar-done-at";

export const maxDuration = 60;

// 過去になったカレンダーイベントを自動的に is_done=true にする
// 30分毎に実行。start_at が現在時刻より前で is_done=false のものが対象。
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const runLogId = await startCronLog("calendar-auto-complete");

  try {
    const now = new Date().toISOString();

    // 2026-09-16 竹内「今日約束した事はカレンダーに【必ず】…連絡漏れが多い」: お客様への約束の行（notes 先頭【必ず】）は時刻が過ぎても
    //   自動で完了にしない。履行した送信（物件送付・御見積書送付・確認結果の報告）が完了にする（app/lib/sent-facts.ts syncPromiseCalendar）
    // 2026-11-22 作業員K2（台帳 #580・ESTIMATE_EVENT_GUARD 既定 on・=off で止まる・app/lib/estimate-event-guard.ts）: 見積の予定は時刻で済みにしない
    //   （済みは見積書を送った時＝save-reply-example の見積書送付の消込・sent-facts の約束の消込）
    const { estimateEventGuardOn, duplicateEstimateEventIds } = await import("@/app/lib/estimate-event-guard");
    const guardOn = estimateEventGuardOn();
    let q = supabase
      .from("calendar_events")
      .update(calendarDonePatch(true))
      .eq("is_done", false)
      .lt("start_at", now);
    if (guardOn) q = q.neq("event_type", "estimate_sheet");
    const { data, error } = await q
      //   内覧の行は手書きの【必ず】があっても従来どおり時刻で完了（内覧は終わる。批評（Fable5）の指摘）
      .or("notes.is.null,notes.not.like.【必ず】%,event_type.eq.viewing")
      .select("id, title, event_type");

    if (error) {
      await finishCronLog(runLogId, false, undefined, error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const updated = (data ?? []).length;
    // ② 同じ会話・同じ時刻（10分以内）の開いている見積の予定は1つにする（【必ず】の行を残す）
    let dupClosed = 0;
    if (guardOn) {
      try {
        const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const { data: openEst } = await supabase.from("calendar_events").select("id, conversation_id, start_at, created_at, notes, is_done, event_type").eq("event_type", "estimate_sheet").eq("is_done", false).gte("start_at", since).limit(2000);
        const ids = duplicateEstimateEventIds((openEst ?? []) as never);
        if (ids.length) { const r = await supabase.from("calendar_events").update(calendarDonePatch(true)).in("id", ids as never[]).eq("is_done", false).select("id"); dupClosed = (r.data ?? []).length; }
      } catch (e) { console.warn("[calendar-auto-complete] estimate dedupe skipped:", e instanceof Error ? e.message : String(e)); }
    }
    const result = { updated, dupClosed, estimateGuard: guardOn, completedAt: now };
    await finishCronLog(runLogId, true, result);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(runLogId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
