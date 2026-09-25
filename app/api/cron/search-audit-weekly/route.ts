// GET /api/cron/search-audit-weekly  （Vercel Cron・月曜 JST 9:00 = 月曜 UTC 0:00・vercel.json "0 0 * * 1"）
// 検索の点検の週のまとめ（2026-09-25 竹内「そうすればずっと拡張ツール側も成長していく。問題や読み取れていない部分が分かる」）:
//   原因ごとの直近7日の数（search_audit_causes.count_7d）を付け直し、上位5件のまとめを DeepSeek で1回だけ作る。
//   まとめは cron_run_logs.result_json に残し、AIXツールの「🔍 検索の点検」が読む。LINE には送らない。
//   ?dry=1 … 数えるだけ（書かない・DeepSeek を呼ばない）
import { NextRequest, NextResponse } from "next/server";
import { weeklySearchAudit } from "@/app/lib/search-audit-server";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const logId = dry ? null : await startCronLog("search-audit-weekly");
  const report = await weeklySearchAudit({ dry });
  await finishCronLog(logId, report.ok, report as unknown as Record<string, unknown>, report.errors[0]);
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}
