/**
 * 読むだけ: 直近の検索点検（search_audits）から、拡張を開いている時の重さの段（page:perf_longtask／page:perf_beat）を並べる。
 *   longtask＝画面が 50ms 以上止まった処理。回数・合計・最大・タブの JS メモリ（2.8.274 から page-script が1分ごとに数える）。
 * 使い方: npx tsx --env-file=.env.local scripts/audit-perf-stats.ts [--hours=24] [--limit=60]
 * ⚠ 営業時間は小分け（limit 既定60行）。書かない。
 */
import { createClient } from "@supabase/supabase-js";

const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1] || d;
const hours = Number(arg("hours", "24"));
const limit = Number(arg("limit", "60"));

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const { data, error } = await sb
    .from("search_audits")
    .select("run_id,created_at,status,site,ext_version,steps")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) { console.error("読めない:", error.message); process.exit(1); }
  const rows = (data || []) as any[];
  const byVer: Record<string, number> = {};
  let nPerf = 0;
  const keyCount: Record<string, number> = {};
  for (const r of rows) {
    byVer[r.ext_version || "?"] = (byVer[r.ext_version || "?"] || 0) + 1;
    const steps: any[] = Array.isArray(r.steps) ? r.steps : [];
    for (const s of steps) {
      const k = String((s?.d || "") + ":" + (s?.k || ""));
      keyCount[k] = (keyCount[k] || 0) + 1;
    }
    const perf = steps.filter((s) => /perf_/.test(String(s?.d || "") + ":" + String(s?.k || "")));
    if (!perf.length) continue;
    nPerf++;
    console.log(`${String(r.created_at).slice(5, 19)} v${r.ext_version || "?"} ${r.site} ${r.status} steps=${steps.length}`);
    perf.slice(0, 12).forEach((s) => console.log(`    ${s.d}:${s.k} ${String(s.at || "").slice(11, 19)} ${JSON.stringify(s).slice(0, 220)}`));
  }
  console.log(`\n対象 ${rows.length} 回（直近${hours}h）・重さの段がある回 ${nPerf}`);
  console.log("版ごとの回数:", JSON.stringify(byVer));
  const top = Object.entries(keyCount).sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log("\n段の多い順（全回の合計・何が一番たくさん動いているか）:");
  top.forEach(([k, v]) => console.log(`  ${v}\t${k}`));
}
main();
