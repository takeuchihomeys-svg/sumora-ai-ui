// GET /api/cron/search-audit-daily  （Vercel Cron・毎日 JST 19:40 = UTC 10:40・vercel.json "40 10 * * *"）
// 検索の点検の毎日のまとめ（2026-09-30 竹内「出来てない部分は改善の改善ループもできるようになるんかな？監視ツールを活かして」）:
//   その日（JST）の search_audits を決まった形で数え、「知らせる事」（失敗の多い組・付け先のずれ・2本走り・ログイン切れ・古い版の PC）を出す。
//   LLM は呼ばない（数えるだけ・app/lib/search-audit-daily.ts）。結果は cron_run_logs.result_json に残す。LINE には送らない。
//   ?dry=1 … 記録しない ／ ?date=2026-09-30 … その日の分を作り直す
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { buildDailyDigest, digestLines, type DailyAuditRow } from "@/app/lib/search-audit-daily";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const dateParam = req.nextUrl.searchParams.get("date");
  const jstDate = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const from = new Date(`${jstDate}T00:00:00+09:00`).toISOString();
  const to = new Date(Date.parse(from) + 86400_000).toISOString();
  const logId = dry ? null : await startCronLog("search-audit-daily");
  const rows: DailyAuditRow[] = [];
  let error: string | null = null;
  for (let i = 0; i < 10_000; i += 1000) {
    const r = await supabase.from("search_audits")
      .select("created_at, finished_at, site, area_mode, trigger, status, error, error_kind, checks, ext_version")
      .gte("created_at", from).lt("created_at", to).order("created_at").range(i, i + 999);
    if (r.error) { error = r.error.message; break; }
    rows.push(...((r.data ?? []) as DailyAuditRow[]));
    if (!r.data || r.data.length < 1000) break;
  }
  const digest = buildDailyDigest(rows);
  const report = { ok: !error, date: jstDate, digest, lines: digestLines(digest), ...(error ? { error } : {}) };
  await finishCronLog(logId, !error, report as unknown as Record<string, unknown>, error ?? undefined);
  return NextResponse.json(report, { status: error ? 500 : 200 });
}
