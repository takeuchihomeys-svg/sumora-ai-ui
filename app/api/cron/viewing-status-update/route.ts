import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const runLogId = await startCronLog("viewing-status-update");

  try {
    // JST で「今日」の日付文字列を取得（UTC+9）
    const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
    const todayJst = `${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}-${String(nowJst.getUTCDate()).padStart(2, "0")}`;

    // viewing_date が今日より前の scheduled レコードを done に更新
    const { data, error } = await supabase
      .from("viewings")
      .update({ status: "done" })
      .eq("status", "scheduled")
      .lt("viewing_date", todayJst)
      .select("id");

    if (error) {
      await finishCronLog(runLogId, false, undefined, error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const updated = (data ?? []).length;
    // 2026-09-14: 内覧の記録（viewing_history・ブレインが読む）も、日付が過ぎた「予定」を閉じる。
    //   実施したかは分からないので done（ブレインは「対面済み」と扱う）ではなく lapsed（日付経過・実施は未確認）。
    //   旧: 閉じる経路が無く「予定」24件中23件が日付を過ぎたまま残り、ブレインに古い予定が「予定」として渡っていた
    const { data: lapsedRows, error: lapsedErr } = await supabase
      .from("viewing_history")
      .update({ status: "lapsed", updated_at: new Date().toISOString() })
      .eq("status", "scheduled")
      .lt("scheduled_date", todayJst)
      .select("id");
    if (lapsedErr) console.warn("[viewing-status-update] viewing_history lapse failed:", lapsedErr.message);
    const result = { updated, lapsed: (lapsedRows ?? []).length, todayJst };
    await finishCronLog(runLogId, true, result);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(runLogId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
