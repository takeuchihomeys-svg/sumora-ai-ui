// @ts-nocheck
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

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

    const { data, error } = await supabase
      .from("calendar_events")
      .update({ is_done: true })
      .eq("is_done", false)
      .lt("start_at", now)
      .select("id, title, event_type");

    if (error) {
      await finishCronLog(runLogId, false, undefined, error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const updated = (data ?? []).length;
    const result = { updated, completedAt: now };
    await finishCronLog(runLogId, true, result);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(runLogId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
