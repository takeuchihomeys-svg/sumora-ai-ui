// app/api/cron/brain-manuals-weekly/route.ts — ブレインの取扱説明書の ①強み・⑦当たり を毎週、本番の竹内さんの番で書き直す（③・作業員1・11/04）
//   11/04 から既定 on（=off で計画だけ）: brain_manuals に書く（それ以外・?dry=1 は書く行の計画と数だけ返す）。基準は竹内さんの番だけ（KB 41dadfe6）
//   夜だけ（vercel.json で 日曜 21:20 UTC＝月曜 06:20 JST）。営業時間（JST 9〜22）は動かない（重い読みをしない）
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { runBrainManualsWeekly } from "@/app/lib/brain-manuals-weekly-server";
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
  if (!url || !key) return NextResponse.json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い（取扱説明書の表はサーバーの鍵だけ）" }, { status: 500 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const logId = await startCronLog("brain-manuals-weekly");
  try {
    const r = await runBrainManualsWeekly(createClient(url, key, { auth: { persistSession: false } }), { days: 30, apply: !dry });
    const summary = {
      turns: r.turns, written: r.written,
      takeuchi: Object.fromEntries(Object.entries(r.stats).map(([b, v]) => [b, `${v.takeuchi.hit}/${v.takeuchi.n}`])),
      employee: Object.fromEntries(Object.entries(r.stats).map(([b, v]) => [b, `${v.employee.hit}/${v.employee.n}`])),
      rows: r.rows.map((x) => `${x.brain}.${x.item}`),
    };
    await finishCronLog(logId, true, summary);
    return NextResponse.json({ ok: true, ...summary, ...(dry || !r.written ? { plan: r.rows.map((x) => ({ brain: x.brain, item: x.item, head: x.body.split("\n")[0] })) } : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
