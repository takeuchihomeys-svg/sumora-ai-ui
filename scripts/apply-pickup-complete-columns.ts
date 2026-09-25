// 売上サポの「完了でまとめる」の列と表を本番DBに作る（migrate-schema/route.ts と同じ DDL）
// 2026-09-25 竹内「まとめられていない。完了ボタン押したらリアプロと itandi の全部分析されるようにする」
// 実行: npx tsx --env-file=.env.local scripts/apply-pickup-complete-columns.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `ALTER TABLE property_pickups ADD COLUMN IF NOT EXISTS complete_group_id TEXT;`,
  `ALTER TABLE property_pickups ADD COLUMN IF NOT EXISTS complete_rank INT;`,
  `CREATE INDEX IF NOT EXISTS idx_property_pickups_complete ON property_pickups(complete_group_id) WHERE complete_group_id IS NOT NULL;`,
  `CREATE TABLE IF NOT EXISTS property_pickup_completions (
  group_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  property_customer_id UUID,
  conversation_id TEXT,
  trigger TEXT,
  mode TEXT,
  requested_by TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  item_ids BIGINT[],
  batch_ids TEXT[],
  sites JSONB,
  best_id BIGINT,
  best_basis TEXT,
  result JSONB,
  finished_at TIMESTAMPTZ
);`,
  `CREATE INDEX IF NOT EXISTS idx_property_pickup_completions_customer ON property_pickup_completions(property_customer_id, created_at DESC);`,
  `ALTER TABLE property_pickup_completions DISABLE ROW LEVEL SECURITY;`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

(async () => {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `NG ${error.message}` : "OK", sql.replace(/\s+/g, " ").slice(0, 90));
  }
  await new Promise((r) => setTimeout(r, 2000));
  const a = await sb.from("property_pickups").select("id, complete_group_id, complete_rank").limit(1);
  console.log("select property_pickups.complete_group_id/complete_rank:", a.error ? `NG ${a.error.message}` : "OK");
  const b = await sb.from("property_pickup_completions").select("group_id").limit(1);
  console.log("select property_pickup_completions:", b.error ? `NG ${b.error.message}` : "OK");
})();
