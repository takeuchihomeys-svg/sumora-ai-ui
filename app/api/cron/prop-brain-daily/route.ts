// app/api/cron/prop-brain-daily/route.ts — 物件出しのブレインの毎朝の物差し（読むだけ・LLM なし・費用 0）
//
// 2026-11-18 作業員K（統括役の付け忘れ防止の表「物件出しのブレインの6つ」の①）: 🌟一致（売上サポの🌟＝スタッフの🌟・書き手ごと）・
//   🌟が拡張の回の上位3／上位10・条件の届き（お客様の条件の発言が物件顧客の列に入ったか）を直近7日で数え、cron_run_logs（cron_name=prop-brain-daily）に残す。
//   数えは app/lib/prop-brain-daily.ts（テスト付き）・読みは app/lib/prop-brain-daily-server.ts。連携の地図の AIX ツールの段の audit 名 audit-prop-brain-score とそろえる。
//   新しい cron は足さない: prod-yardstick（JST 1:10）の cron-chain の子として呼ぶ（CRON_CHAIN_PROD_YARDSTICK=on の時）。単独でも呼べる。止める: PROP_BRAIN_DAILY_CRON=off
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { loadPropBrainDaily } from "@/app/lib/prop-brain-daily-server";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if ((process.env.PROP_BRAIN_DAILY_CRON ?? "").trim().toLowerCase() === "off") return NextResponse.json({ ok: true, skipped: "PROP_BRAIN_DAILY_CRON=off" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" }, { status: 500 });
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const logId = await startCronLog("prop-brain-daily");
  try {
    const result = await loadPropBrainDaily(sb, { days: 7 });
    await finishCronLog(logId, true, result);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, {}, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
