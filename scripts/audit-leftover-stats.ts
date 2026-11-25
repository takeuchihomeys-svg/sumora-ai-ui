/**
 * 読むだけ: 直近の検索点検（search_audits）で「前客の外し」の結果を数える。
 *   leftover_scan / leftover_after_clear / leftover_rescan / leftover_stuck / clear_then_fill_ok / 関所の段
 * 使い方: npx tsx --env-file=.env.local scripts/audit-leftover-stats.ts [--hours=48] [--limit=60]
 * ⚠ 営業時間は小分け（limit 既定60行・期間 48h）。書かない。
 */
import { createClient } from "@supabase/supabase-js";

const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1] || d;
const hours = Number(arg("hours", "48"));
const limit = Number(arg("limit", "60"));

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const sb = createClient(url, key);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const { data, error } = await sb
    .from("search_audits")
    .select("run_id,created_at,status,site,property_customer_id,ext_version,steps,checks")
    .eq("site", "realpro")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) { console.error("読めない:", error.message); process.exit(1); }
  const rows = data || [];
  console.log(`対象 ${rows.length} 回（realpro・直近${hours}h）`);
  const keys = ["leftover_scan", "leftover_after_clear", "leftover_rescan", "leftover_stuck", "leftover_soft_stay", "clear_then_fill_ok", "clean_no_clear", "gate_prev_leftover", "gate_stop_basic", "condition_drift"];
  const tot: Record<string, number> = {};
  const per: string[] = [];
  for (const r of rows as any[]) {
    const steps: any[] = Array.isArray(r.steps) ? r.steps : [];
    const c: Record<string, number> = {};
    const samples: string[] = [];
    for (const s of steps) {
      const k = String((s?.d || "") + ":" + (s?.k || s?.step || s?.name || ""));
      const txt = String(s?.v || s?.detail || s?.t || s?.x || JSON.stringify(s).slice(0, 140));
      for (const kk of keys) {
        if (k.includes(kk)) {
          c[kk] = (c[kk] || 0) + 1;
          tot[kk] = (tot[kk] || 0) + 1;
          if ((kk === "leftover_after_clear" || kk === "leftover_stuck" || kk === "leftover_rescan") && samples.length < 3) samples.push(`${kk}: ${txt.slice(0, 110)}`);
        }
      }
    }
    const chk = JSON.stringify(r.checks || "").includes("drift") ? "drift有" : "";
    per.push(`${String(r.created_at).slice(5, 16)} v${r.ext_version || "?"} ${r.status || ""} 客${String(r.property_customer_id || "").slice(0, 6)} ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(" ")} ${chk}${samples.length ? "\n      " + samples.join("\n      ") : ""}`);
  }
  console.log("\n— 合計 —");
  keys.forEach((k) => console.log(`  ${k}: ${tot[k] || 0}`));
  console.log("\n— 1回ごと（新しい順・段が出た回だけ） —");
  per.filter((l) => /=\d/.test(l)).slice(0, 25).forEach((l) => console.log("  " + l));
  const stepSample = (rows[0] as any)?.steps;
  if (Array.isArray(stepSample) && stepSample.length) console.log("\n（段の形の例）", JSON.stringify(stepSample[0]).slice(0, 200));
}
main();

