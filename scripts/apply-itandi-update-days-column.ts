// property_customers.itandi_update_days（ITANDI の更新日の手の指定・リアプロの rp_update_days と別）を本番DBに作る（migrate-schema/route.ts と同じ DDL）
// 2026-10-06 v2.5.76 竹内「itandiで検索したら連動してリアプロも1日となってしまっているので itandi・リアプロそれぞれの更新日にする必要がある」
// 実行: npx tsx --env-file=.env.local scripts/apply-itandi-update-days-column.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const STMTS = [
  `ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS itandi_update_days INTEGER;`,
  `COMMENT ON COLUMN property_customers.itandi_update_days IS 'ITANDI の募集条件更新 N日以内の手の指定（NULL＝自動）。リアプロは rp_update_days';`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];
(async () => {
  for (const sql of STMTS) { const { error } = await sb.rpc("exec_sql", { sql }); console.log(error ? `NG ${error.message}` : "OK", sql.slice(0, 80)); }
  await new Promise((r) => setTimeout(r, 1500));
  const a = await sb.from("property_customers").select("id, itandi_update_days").limit(1);
  console.log("select property_customers.itandi_update_days:", a.error ? `NG ${a.error.message}` : "OK");
})();
