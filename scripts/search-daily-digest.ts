// scripts/search-daily-digest.ts — 検索の点検の毎日のまとめを手元で出す（読むだけ）
// 実行: npx tsx --env-file=.env.local scripts/search-daily-digest.ts [--date=2026-09-30]（JST の1日・既定は今日）
import { createClient } from "@supabase/supabase-js";
import { buildDailyDigest, digestLines, type DailyAuditRow } from "../app/lib/search-audit-daily";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const dateArg = process.argv.slice(2).find((a) => a.startsWith("--date="))?.slice(7);
const jstDate = dateArg ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

async function main() {
  const from = new Date(`${jstDate}T00:00:00+09:00`).toISOString();
  const to = new Date(Date.parse(from) + 86400_000).toISOString();
  const rows: DailyAuditRow[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("search_audits").select("created_at, finished_at, site, area_mode, trigger, status, error, error_kind, checks, ext_version").gte("created_at", from).lt("created_at", to).order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as DailyAuditRow[]));
    if (!data || data.length < 1000) break;
  }
  console.log(`【${jstDate} の検索の点検】`);
  for (const l of digestLines(buildDailyDigest(rows))) console.log(l);
}
main().catch((e) => { console.error(e); process.exit(1); });
