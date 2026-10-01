// GET /api/cron/line-watch-daily  （Vercel Cron・毎日 JST 20:50 = UTC 11:50・vercel.json "50 11 * * *"・line-watch-eval（20:40）の後）
// LINE の見張りの毎日のまとめ（2026-10-01 竹内「見張りの2段目おこなう」・設計 line-watch-design.md §6）:
//   場面ごとの一致率（解禁の線までの残り・停止の線）・最終チェックの段ごとの指摘・返信遅れ・約束の未対応・カレンダー C1〜C7
//   （C7＝申込ツールの daily_tasks との食い違い・読むだけ）・物件検索・👍✋ を数え、「知らせる事」を決まった線で出す（app/lib/line-watch-daily.ts）。
//   LLM は呼ばない。結果は cron_run_logs.result_json（画面 /watch の「今日のまとめ」が読む）。LINE には送らない（売上番長グループは今まで通り AIX要対応だけ）。
//   ?dry=1 … 記録しない
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { buildLineWatchDailyReport } from "@/app/lib/line-watch-eval-server";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const logId = dry ? null : await startCronLog("line-watch-daily");
  try {
    const report = await buildLineWatchDailyReport(supabase);
    const errText = Object.entries(report.errors).map(([k, v]) => `${k}: ${v}`).join(" / ");
    // 欄が1つ読めなくても、まとめは残す（ok は「全部読めた」か）
    await finishCronLog(logId, report.ok, report as unknown as Record<string, unknown>, errText || undefined);
    return NextResponse.json(report, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[line-watch-daily] failed:", msg);
    await finishCronLog(logId, false, { error: msg }, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
