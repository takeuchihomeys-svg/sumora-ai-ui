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

    // 2026-09-16 竹内「今日約束した事はカレンダーに【必ず】…連絡漏れが多い」: お客様への約束の行（notes 先頭【必ず】）は時刻が過ぎても
    //   自動で完了にしない。履行した送信（物件送付・御見積書送付・確認結果の報告）が完了にする（app/lib/sent-facts.ts syncPromiseCalendar）
    const { data, error } = await supabase
      .from("calendar_events")
      .update({ is_done: true })
      .eq("is_done", false)
      .lt("start_at", now)
      //   内覧の行は手書きの【必ず】があっても従来どおり時刻で完了（内覧は終わる。批評（Fable5）の指摘）
      .or("notes.is.null,notes.not.like.【必ず】%,event_type.eq.viewing")
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
