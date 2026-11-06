// GET /api/cron/conductor-reflection（Vercel Cron・毎週月曜 JST 4:10）— 統括の毎週の振り返り（#10・#14・弱い所 277・作業員5・11/07）
//   1週間の見張りの番（line_watch_turns・スタッフが返した番）から、場面ごとにブレインの道とスタッフの一手の当たりを数え、
//   当たりの低い場面（5番以上・6割未満・外れの多い順に3つ）を brain_weaknesses と owner_questions（推奨付き）に足す。LLM なし＝費用 0。
//   既定で書く（11/07 から既定 on・CONDUCTOR_REFLECTION=off か ?dry=1 は数えて返すだけ）。営業時間（JST 9〜22時）は動かない。読みは 1000行ずつ・最大 5000行
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { conductorReflectionOn, sceneStats, weakScenes, weekKey, weaknessRow, questionRow, type WatchRow } from "@/app/lib/conductor-reflection";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const h = new Date(Date.now() + 9 * 3600_000).getUTCHours();
  if (h >= 9 && h < 22) return NextResponse.json({ ok: true, skipped: "営業時間（JST 9〜22）は動かない" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" }, { status: 500 });
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const write = conductorReflectionOn() && req.nextUrl.searchParams.get("dry") !== "1";
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rows: WatchRow[] = [];
  for (let i = 0; i < 5000; i += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("scene_key, brain_action, brain_reply_mode, staff_aix, staff_first_at")
      .gte("customer_turn_at", since).not("staff_first_at", "is", null).order("customer_turn_at", { ascending: true }).range(i, i + 999);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    rows.push(...((data ?? []) as WatchRow[]));
    if ((data ?? []).length < 1000) break;
  }
  const week = weekKey(new Date());
  const stats = sceneStats(rows), weak = weakScenes(stats);
  let wrote = 0, asked = 0;
  if (write && weak.length) {
    const now = new Date().toISOString();
    const w = await sb.from("brain_weaknesses").upsert(weak.map((s) => ({ ...weaknessRow(week, s), first_seen: now, last_seen: now, updated_at: now })), { onConflict: "key" });
    if (!w.error) wrote = weak.length;
    const q = await sb.from("owner_questions").upsert(weak.map((s) => questionRow(week, s)), { onConflict: "dedupe_key", ignoreDuplicates: true });
    if (!q.error) asked = weak.length;
  }
  return NextResponse.json({ ok: true, write, week, turns: rows.length, scenes: stats.slice(0, 12), weak: weak.map((s) => s.scene), wrote, asked });
}
