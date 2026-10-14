// GET /api/cron/reading-audit-weekly （Vercel Cron・月曜 JST 9:40 = 月曜 UTC 0:40・vercel.json "40 0 * * 1"）
// 物件資料・画像の読み取りの誤りを週に1回数える（2026-10-14 竹内さん「週1回、読み取りの誤り（文字の層・スタッフの入力・売上サポと照らす・
//   中国の字形・号室・金額・退去日）を自動で数える仕組み」）。中身は app/lib/reading-audit-server.ts（DB を読むだけ・LLM なし・$0）。
//   結果は cron_run_logs.result_json（alerts が落ちた印）。LINE には送らない（送る案は memory/dept_line_reply.md の 10/14 読み取りの仕上げ）
//   ?days=N … 数える日数（既定 7）／?dry=1 … cron_run_logs に書かない
import { NextRequest, NextResponse } from "next/server";
import { weeklyReadingAudit } from "@/app/lib/reading-audit-server";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const days = Math.min(60, Math.max(1, Number(req.nextUrl.searchParams.get("days") ?? 7) || 7));
  const logId = dry ? null : await startCronLog("reading-audit-weekly");
  const report = await weeklyReadingAudit({ days });
  await finishCronLog(logId, report.ok, report as unknown as Record<string, unknown>, report.errors[0]);
  if (report.alerts.length) console.warn(JSON.stringify({ tag: "reading-audit:alerts", alerts: report.alerts }));
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}
