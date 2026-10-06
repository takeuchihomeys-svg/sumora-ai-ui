// property_pickups.search_conditions（この回の一覧を検索した時の条件）を本番DBに作る（migrate-schema/route.ts と同じ DDL）
// 2026-10-06 v2.5.81（⑯）
// 実行: npx tsx --env-file=.env.local scripts/apply-pickup-search-conditions.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const STMTS = [
  `ALTER TABLE property_pickups ADD COLUMN IF NOT EXISTS search_conditions JSONB;`,
  `COMMENT ON COLUMN property_pickups.search_conditions IS 'この回の一覧を検索した時の条件 {v:1, site, at, complete, intended:{area_mode, station_names, city_codes, rent_min, rent_max, floor_plan, is_wide…}, filled:{rent_min, rent_max, layouts, stations, city_codes…}}（拡張 search-stamp.js）';`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];
(async () => {
  for (const sql of STMTS) { const { error } = await sb.rpc("exec_sql", { sql }); console.log(error ? `NG ${error.message}` : "OK", sql.slice(0, 70)); }
  await new Promise((r) => setTimeout(r, 1500));
  const a = await sb.from("property_pickups").select("id, search_conditions").limit(1);
  console.log("select property_pickups.search_conditions:", a.error ? `NG ${a.error.message}` : "OK");
})();
