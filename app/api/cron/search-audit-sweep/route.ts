// GET /api/cron/search-audit-sweep  （Vercel Cron・15分ごと）
// 検索の点検の見回り（2026-09-25 竹内「検索がちゃんとされていなかったら原因を見つけられるようにする」）:
//   ① started のまま20分たった回を abandoned にして札 STALLED を付ける（拡張が落ちた・PC が閉じられた等＝終わりの合図が来ない回）
//   ② 見立て（DeepSeek）の残り（ai_status=pending・応答の後の waitUntil が落ちた分）を1回20件まで
//   ?dry=1 は無い（書き込みは見回りの札だけ・LINE には送らない）
import { NextRequest, NextResponse } from "next/server";
import { sweepSearchAudits } from "@/app/lib/search-audit-server";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const logId = await startCronLog("search-audit-sweep");
  // 見立て1件は最長 40秒（20秒×読み直し1回）。240秒を過ぎたら新しい見立てを始めない
  const report = await sweepSearchAudits({ deadlineAt: Date.now() + 240_000, limit: 20 });
  await finishCronLog(logId, report.ok, report as unknown as Record<string, unknown>, report.errors[0]);
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}
