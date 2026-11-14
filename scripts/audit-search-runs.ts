/**
 * search_audits の直近を見る（何を意図して・実際に何を押したか）2026-11-14
 * 実行: npx tsx --env-file=.env.local scripts/audit-search-runs.ts
 */
import { supabase as sb } from "../app/lib/supabase-server";

void (async () => {
  const { data, error } = await sb
    .from("search_audits")
    .select("run_id, created_at, site, mode, status, area_mode, intended, filled, steps, result, error, ext_version, checks")
    .eq("site", "realpro")
    .order("created_at", { ascending: false })
    .limit(6);
  if (error) { console.log("読めません:", error.message); return; }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  console.log(`直近 ${rows.length} 回\n`);
  for (const r of rows) {
    console.log("─".repeat(70));
    console.log(`時刻: ${String(r.created_at)} / 版: ${String(r.ext_version)} / mode: ${String(r.mode)} / status: ${String(r.status)}`);
    console.log(`area_mode: ${String(r.area_mode)}`);
    const it = r.intended as Record<string, unknown> | null;
    if (it) console.log("intended:", JSON.stringify(it).slice(0, 400));
    const fl = r.filled as Record<string, unknown> | null;
    if (fl) {
      const keys = ["ward", "wards", "city_codes", "detail_ward", "town", "station", "layout", "rent"];
      const pick: Record<string, unknown> = {};
      for (const k of keys) if (fl[k] !== undefined) pick[k] = fl[k];
      console.log("filled(抜粋):", JSON.stringify(pick).slice(0, 400));
    }
    const steps = r.steps as Array<Record<string, unknown>> | null;
    if (Array.isArray(steps) && steps.length) {
      console.log(`steps (${steps.length}件・最後10件):`);
      for (const s of steps.slice(-10)) {
        console.log("   ", JSON.stringify(s).slice(0, 200));
      }
    }
    if (r.error) console.log("error:", String(r.error).slice(0, 300));
    if (r.result) console.log("result:", JSON.stringify(r.result).slice(0, 250));
  }
})();
