// GET /api/cron/shot-retention … 自動モード（aix・ai）の未読の写真を撮って14日で Storage から消す（毎日 JST 3:50）
//   ?dry=1 … 消す予定（日・モードごとの枚数・MB）だけ返す
// 決まりの中身は app/lib/shot-retention.ts（2026-11-20 竹内さんの決定）
import { NextRequest, NextResponse } from "next/server";
import { cleanupUnreadAutoShots } from "@/app/lib/shot-retention";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const logId = dry ? null : await startCronLog("shot-retention");
  const r = await cleanupUnreadAutoShots({ dry, budgetMs: 45_000 });
  const ok = !r.error;
  await finishCronLog(logId, ok, r as unknown as Record<string, unknown>, r.error);
  console.log(JSON.stringify({ tag: "shot-retention", dry, candidates: r.candidates, candidateMB: r.candidateMB, removed: r.removed, skipped: r.skipped ?? null, more: !!r.more, error: r.error ?? null }));
  return NextResponse.json({ ok, ...r }, { status: ok ? 200 : 500 });
}
