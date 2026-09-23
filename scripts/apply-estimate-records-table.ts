// estimate_records と sent_properties の AD 列を本番DBに作る（migrate-schema/route.ts と同じ DDL を流す）
// 2026-09-24 竹内「AD − 見積書の割引金額が利益。連動するようにする」
// 実行: npx tsx --env-file=.env.local scripts/apply-estimate-records-table.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `ALTER TABLE sent_properties ADD COLUMN IF NOT EXISTS ad_months NUMERIC;`,
  `ALTER TABLE sent_properties ADD COLUMN IF NOT EXISTS ad_yen INTEGER;`,
  `CREATE TABLE IF NOT EXISTS estimate_records (
     id BIGSERIAL PRIMARY KEY,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     aix_usage_log_id UUID,
     item_index INT NOT NULL DEFAULT 0,
     conversation_id TEXT,
     property_customer_id UUID,
     property_name TEXT,
     room_no TEXT,
     discount_yen INTEGER,
     initial_cost_yen INTEGER,
     rent INTEGER,
     ad_months NUMERIC,
     ad_yen INTEGER,
     ad_source TEXT,
     ad_matched_name TEXT,
     profit_yen INTEGER,
     source TEXT NOT NULL DEFAULT 'aix_text',
     estimated_at TIMESTAMPTZ
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_estimate_records_log_item ON estimate_records(aix_usage_log_id, item_index);`,
  `CREATE INDEX IF NOT EXISTS idx_estimate_records_customer ON estimate_records(property_customer_id, estimated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_estimate_records_conv ON estimate_records(conversation_id, estimated_at DESC);`,
  `ALTER TABLE estimate_records DISABLE ROW LEVEL SECURITY;`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

async function main() {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `⚠ ${error.message}\n   ${sql.slice(0, 60)}` : `✅ ${sql.split("\n")[0].slice(0, 70)}`);
  }
  const { error } = await sb.from("estimate_records").select("id").limit(1);
  console.log(error ? `⚠ 読めない: ${error.message}` : "✅ estimate_records を読める");
}
main().catch((e) => { console.error(e); process.exit(1); });
