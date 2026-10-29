// app/api/cron/aix-desk-cards/route.ts — AIX の担当の札を週1で作り直して表 aix_desk_cards に書く（2026-10-29 作業員1・竹内さん KB P1 03d2bdd2）
//   読み: 公開の窓口でも読める表（aix_usage_logs・messages・templates・設計知見）。書き: aix_desk_cards（RLS 有効・ポリシーなし）＝サーバーの鍵の client だけ。
//   ?dry=1 は作るだけで書かない（件数と薄い札の数を返す）。札の本文は返さない（伏せた文でも外に出さない）
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "@/app/lib/supabase-server";
import { buildAixDeskCards, upsertAixDeskCards, AIX_DESK_OWNER_MIN } from "@/app/lib/aix-desk-cards-build";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!dry && (!url || !key)) return NextResponse.json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い（札の表はサーバーの鍵だけで書ける）" }, { status: 500 });
  const logId = dry ? null : await startCronLog("aix-desk-cards");
  try {
    const admin = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
    const { cards, usages } = await buildAixDeskCards(admin ?? supabase, { days: 180 });
    const genAt = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
    if (!dry && admin) await upsertAixDeskCards(admin, cards, `aix_usage_logs 180日（${usages}件）・${genAt} JST・cron`);
    const summary = { cards: cards.length, thin: cards.filter((c) => c.thin.length).length, ownerUnder: cards.filter((c) => c.owner < AIX_DESK_OWNER_MIN).length, usages, written: !dry };
    await finishCronLog(logId, true, summary);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
