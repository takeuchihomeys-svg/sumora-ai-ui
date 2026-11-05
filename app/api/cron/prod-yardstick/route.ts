// app/api/cron/prod-yardstick/route.ts — 本番の記録の毎晩の物差し（読むだけ・LLM なし・費用 0）
//
// 2026-11-05 作業員8（竹内さんの了承「本番の記録を毎晩の物差しにする（LLM なし・下がった場面だけ試験）」・統括役「本番の cron にして cron_run_logs と表に残す」）:
//   竹内さんの番の当たり（ブレインの道の系統＝最初の一手の系統）を、前の7日と今の7日で場面ごとに比べ、はっきり下がった場面を出す
//   （scripts/lib/prod-yardstick.ts の Wilson の幅・5番未満は待つ）。試験の問題への対応と割れの表は手元の scripts/prod-yardstick-night.ts。
//   結果は cron_run_logs（cron_name=prod-yardstick）の result_json。止める: PROD_YARDSTICK_CRON=off。JST 1:10（営業時間の外）
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { runYardstick } from "../../../../scripts/lib/prod-yardstick-db";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if ((process.env.PROD_YARDSTICK_CRON ?? "").trim().toLowerCase() === "off") return NextResponse.json({ ok: true, skipped: "PROD_YARDSTICK_CRON=off" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" }, { status: 500 });
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const logId = await startCronLog("prod-yardstick");
  try {
    const days = Math.min(14, Math.max(1, Number(req.nextUrl.searchParams.get("days") ?? "7") || 7));
    const { out } = await runYardstick(sb, { days });
    const summary = `本番の物差し（見張りの番 前 ${out.turns.before}→今 ${out.turns.after}・${days}日ずつ・場面の比べは竹内さんの番だけ）: 下がった場面 ${out.down.length ? out.down.map((d) => `${d.scene} ${Math.round(d.pBefore * 100)}%→${Math.round(d.pAfter * 100)}%`).join("・") : "なし"}（待つ ${out.few}）`;
    const result = { summary, days, turns: out.turns, down: out.down, few: out.few, beyond: out.beyond,
      scenes: out.drift.map((d) => ({ scene: d.scene, verdict: d.verdict, before: d.before, after: d.after, pBefore: +d.pBefore.toFixed(3), pAfter: +d.pAfter.toFixed(3) })) };
    await finishCronLog(logId, true, result);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, {}, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
