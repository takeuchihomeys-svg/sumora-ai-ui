// app/api/cron/conductor-turn-vectors/route.ts — 近い過去の番の表（conductor_turn_vectors）を夜に埋める（⑤(a)・作業員1・11/04）
//   既定 off: CONDUCTOR_TURN_VECTORS=on の時だけ書く（表は 11/04 竹内さんの了承で作った・vercel.json は毎晩 JST 01:50）。?dry=1 か off の時は作れる数だけ返す（埋め込みも呼ばない）
//   夜だけ（JST 22〜9）。営業時間は動かない。基準は竹内さんの番だけ（staff_writer=takeuchi・sure）
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fillConductorTurnVectors } from "@/app/lib/conductor-turn-vectors-server";
import { conductorTurnVectorsOn } from "@/app/lib/conductor-turn-vectors";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const h = new Date(Date.now() + 9 * 3600_000).getUTCHours();
  if (h >= 9 && h < 22) return NextResponse.json({ ok: true, skipped: "営業時間（JST 9〜22）は動かない" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" }, { status: 500 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  // off の毎晩の回は何も読まない（DB の読みを増やさない）。数えたい時だけ ?dry=1
  if (!dry && !conductorTurnVectorsOn()) return NextResponse.json({ ok: true, skipped: "CONDUCTOR_TURN_VECTORS が off（数えるなら ?dry=1）" });
  const logId = await startCronLog("conductor-turn-vectors");
  try {
    const r = await fillConductorTurnVectors(createClient(url, key, { auth: { persistSession: false } }), { days: 90, limit: 200, apply: !dry });
    await finishCronLog(logId, true, r);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
