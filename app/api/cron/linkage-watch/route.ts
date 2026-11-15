// app/api/cron/linkage-watch/route.ts — 連携の地図の見張り（毎朝・読むだけ・LLM なし・費用0）
//
// 2026-11-15 作業員L（KB P0 3041baaa）: 地図（app/lib/linkage-map.ts）の行ごとに、作る側と読む側のスイッチが本番で on か・本番の記録で欄が空でない割合を数え、
//   cron_run_logs（cron_name=linkage-watch）に「切れている行の数・先週から増えた／減った」の1行と切れている行の一覧を残す。
//   止める: LINKAGE_WATCH_CRON=off（既定 on・記録だけ）。JST 5:40（営業時間の外・読みは件数と直近 60会話の meta だけ）
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { runLinkageWatch, compactResult, LINKAGE_CRON_NAME } from "@/app/lib/linkage-watch-server";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if ((process.env.LINKAGE_WATCH_CRON ?? "").trim().toLowerCase() === "off") return NextResponse.json({ ok: true, skipped: "LINKAGE_WATCH_CRON=off" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" }, { status: 500 });
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const logId = await startCronLog(LINKAGE_CRON_NAME);
  try {
    const rep = await runLinkageWatch(sb);
    const result = compactResult(rep);
    await finishCronLog(logId, true, result);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, {}, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
