// property_pickups.expired_at（売上サポの画像・資料の保存期間が終わった時刻）を本番DBに作る（migrate-schema/route.ts と同じ DDL）
// 2026-09-25 竹内「3日前の画像は消されるように。保存期間が終了しましたと出る感じで（実際の LINE のように）」
// 実行: npx tsx --env-file=.env.local scripts/apply-pickup-expired-column.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `ALTER TABLE property_pickups ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;`,
  `CREATE INDEX IF NOT EXISTS idx_property_pickups_retention ON property_pickups(created_at) WHERE expired_at IS NULL;`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

(async () => {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `NG ${error.message}` : "OK", sql.slice(0, 80));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const a = await sb.from("property_pickups").select("id, expired_at").limit(1);
  console.log("select property_pickups.expired_at:", a.error ? `NG ${a.error.message}` : "OK");
})();
