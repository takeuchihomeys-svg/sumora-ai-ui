// GET /api/cron/sent-image-reread （Vercel Cron・毎日 JST 4:50）
//   ?dry=1 … 読み直す送付を数えるだけ（読まない・書かない）。&hours=<時間>（既定72）・&limit=<件>（既定40）
// 2026-11-05 作業員1（案3'）: DeepSeek の失敗（残高切れ等）で読めなかった送付の資料の画像を、DeepSeek で読み直して送った物件の記録を埋める。
//   読み取りを Claude に倒さない（竹内さんの決まり・KB e3b1e901）。LINE には何も送らない。仕組みは app/lib/sent-image-reread.ts。
import { NextRequest, NextResponse } from "next/server";
import { runSentImageReread } from "@/app/lib/sent-image-reread-server";
import { withCronLog } from "@/app/lib/cron-log-wrap";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function handleGET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const num = (k: string) => { const v = Number(sp.get(k)); return Number.isFinite(v) && v > 0 ? v : undefined; };
  const report = await runSentImageReread({ dry: sp.get("dry") === "1", windowHours: num("hours"), limit: num("limit") });
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}

// 2026-11-21 作業員N: cron_run_logs に記録を残す（記録だけ・動きは変えない・止める CRON_LOG_WRAP=off）
export const GET = withCronLog("sent-image-reread", handleGET);
