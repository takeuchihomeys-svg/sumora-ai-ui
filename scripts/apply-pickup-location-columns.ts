// property_pickups.location と property_customers.condition_summary / condition_summary_hash を本番DBに作る（migrate-schema/route.ts と同じ DDL）
// 2026-09-25 竹内「エリアの部分、把握できれば理想」「通勤の部分も沿線の知識」「文章の部分も要約できるようにする」
// 実行: npx tsx --env-file=.env.local scripts/apply-pickup-location-columns.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `ALTER TABLE property_pickups ADD COLUMN IF NOT EXISTS location JSONB;`,
  `ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS condition_summary JSONB;`,
  `ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS condition_summary_hash TEXT;`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

(async () => {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `NG ${error.message}` : "OK", sql.slice(0, 80));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const a = await sb.from("property_pickups").select("id, location").limit(1);
  const b = await sb.from("property_customers").select("id, condition_summary, condition_summary_hash").limit(1);
  console.log("select property_pickups.location:", a.error ? `NG ${a.error.message}` : "OK");
  console.log("select property_customers.condition_summary:", b.error ? `NG ${b.error.message}` : "OK");
})();
