// app/api/cron/compose-prod-daily/route.ts — 文の当たりの本番の物差し（毎朝・読むだけ・LLM なし・費用 0）
//
// 2026-11-15 作業員H（統括役の頼み③・prod-yardstick と同じ形）: 竹内さん本人の返信の番の実送信と、その番の下書き（line_watch_turns.draft_last）を、
//   文の要素ごと（頭・押さえ・信頼・潜在・つなぎ・締め・事実・2通目）に前の7日と今の7日で比べ、cron_run_logs（cron_name=compose-prod-daily）に残す。
//   比べ方は scripts/lib/compose-prod-elements.ts（試験の物差し compose-gold と同じ関数）・読みは scripts/lib/compose-prod-daily-db.ts（手元の台本 scripts/compose-prod-daily.ts と同じ）。
//   止める: COMPOSE_PROD_DAILY_CRON=off。JST 5:20（営業時間の外）
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { runComposeProdDaily } from "../../../../scripts/lib/compose-prod-daily-db";
import { PROD_ELEMENTS } from "../../../../scripts/lib/compose-prod-elements";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if ((process.env.COMPOSE_PROD_DAILY_CRON ?? "").trim().toLowerCase() === "off") return NextResponse.json({ ok: true, skipped: "COMPOSE_PROD_DAILY_CRON=off" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" }, { status: 500 });
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const logId = await startCronLog("compose-prod-daily");
  try {
    const days = Math.min(14, Math.max(1, Number(req.nextUrl.searchParams.get("days") ?? "7") || 7));
    const { before, after } = await runComposeProdDaily(sb, days);
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);
    const summary = `文の当たり（竹内さん本人の返信の番・前 ${before.turns}→今 ${after.turns}・${days}日ずつ）: ${PROD_ELEMENTS.map((e) => `${e} ${pct(before.tally[e].hit, before.tally[e].has) ?? "-"}%→${pct(after.tally[e].hit, after.tally[e].has) ?? "-"}%`).join("・")}`;
    const result = { summary, days, turns: { before: before.turns, after: after.turns }, before: before.tally, after: after.tally,
      misses: after.results.filter((x) => x.r.some((y) => y.has && !y.hit)).slice(0, 30).map((x) => ({ id: x.id, at: x.at, miss: x.r.filter((y) => y.has && !y.hit).map((y) => `${y.el}:${y.detail}`) })) };
    await finishCronLog(logId, true, result);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, {}, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
