// app/api/cron/conductor-turn-vectors/route.ts — 近い過去の番の表（conductor_turn_vectors）を夜に埋める（⑤(a)・作業員1・11/04）
//   11/04 から既定 on（=off で止める）: on の時に書く（表は 11/04 竹内さんの了承で作った・vercel.json は毎晩 JST 01:50）。?dry=1 か off の時は作れる数だけ返す（埋め込みも呼ばない）
//   夜だけ（JST 22〜9）。営業時間は動かない。基準は竹内さんの番だけ（staff_writer=takeuchi・sure）
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fillConductorTurnVectors, backfillCursor, v2BackfillCursor, conductorTurnVectorsV2On } from "@/app/lib/conductor-turn-vectors-server";
import { conductorTurnVectorsOn } from "@/app/lib/conductor-turn-vectors";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  // 2026-11-04 統括役（竹内さん「今日入れていって良い」）: 過去90日の一括の埋め＝?backfill=1（vercel.json に一時の5分ごと）。
  //   11/05 0時 JST を過ぎたら動かない（一時の物）・CONDUCTOR_TURN_VECTORS_BACKFILL=off で止める・90日に届いたら done を返すだけ。営業時間でも動く（1回 200番・索引の効く読み）
  const backfill = req.nextUrl.searchParams.get("backfill") === "1";
  if (backfill) {
    if (Date.now() >= Date.parse("2026-11-05T00:00:00+09:00") || (process.env.CONDUCTOR_TURN_VECTORS_BACKFILL ?? "").trim().toLowerCase() === "off") return NextResponse.json({ ok: true, skipped: "一括の埋めは終わり（期限か off）" });
  } else {
    const h = new Date(Date.now() + 9 * 3600_000).getUTCHours();
    if (h >= 9 && h < 22) return NextResponse.json({ ok: true, skipped: "営業時間（JST 9〜22）は動かない" });
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" }, { status: 500 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  // off の毎晩の回は何も読まない（DB の読みを増やさない）。数えたい時だけ ?dry=1
  if (!dry && !conductorTurnVectorsOn()) return NextResponse.json({ ok: true, skipped: "CONDUCTOR_TURN_VECTORS が off（数えるなら ?dry=1）" });
  const sb = createClient(url, key, { auth: { persistSession: false } });
  let before: string | null = null;
  if (backfill) {
    before = await backfillCursor(sb);
    if (before && Date.parse(before) < Date.now() - 90 * 86_400_000) return NextResponse.json({ ok: true, done: true, before });
  }
  const logId = await startCronLog(backfill ? "conductor-turn-vectors-backfill" : "conductor-turn-vectors");
  try {
    const r = await fillConductorTurnVectors(sb, { days: 90, limit: 200, apply: !dry, before });
    // 2026-11-05 作業員5: v2 が on の夜は、新しい番の後に、v2 がまだ無い古い番を同じ回で 200番まで作り直す（約5晩で 1,000番・埋め込み 約 $0.001/晩）
    let r2: Awaited<ReturnType<typeof fillConductorTurnVectors>> | null = null;
    if (!backfill && !dry && conductorTurnVectorsV2On() && !r.timeBudgetHit) {
      const cur = await v2BackfillCursor(sb);
      if (cur) r2 = await fillConductorTurnVectors(sb, { days: 90, limit: 200, apply: true, before: cur, budgetMs: 60_000 });
    }
    await finishCronLog(logId, true, { ...r, before, ...(r2 ? { v2Backfill: r2 } : {}) });
    return NextResponse.json({ ok: true, ...r, ...(r2 ? { v2Backfill: r2 } : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
