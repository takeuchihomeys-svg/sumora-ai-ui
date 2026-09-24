// property_pickups と region_map/station_map の priority を本番DBに作る（migrate-schema/route.ts と同じ DDL）
// 2026-09-24 竹内「ピックアップを売上サポに飛ばして確認→送るだけ」「手直しを学習」
// 実行: npx tsx --env-file=.env.local scripts/apply-property-pickups-table.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `CREATE TABLE IF NOT EXISTS property_pickups (
     id BIGSERIAL PRIMARY KEY,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     batch_id TEXT NOT NULL,
     property_customer_id UUID,
     conversation_id TEXT,
     customer_name TEXT,
     site TEXT,
     rank INT NOT NULL DEFAULT 0,
     property_name TEXT NOT NULL,
     room_no TEXT,
     summary_text TEXT NOT NULL,
     pdf_url TEXT,
     pdf_blob_url TEXT,
     pdf_text TEXT,
     pdf_has_text BOOLEAN NOT NULL DEFAULT false,
     verdict TEXT,
     score INT,
     reason_codes TEXT[],
     reasons_ja TEXT[],
     ad_yen INTEGER,
     profit_yen INTEGER,
     recommended INT NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'pending',
     sent_at TIMESTAMPTZ,
     sent_by TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS idx_property_pickups_batch ON property_pickups(batch_id, rank);`,
  `CREATE INDEX IF NOT EXISTS idx_property_pickups_status ON property_pickups(status, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_property_pickups_customer ON property_pickups(property_customer_id, created_at DESC);`,
  `ALTER TABLE property_pickups DISABLE ROW LEVEL SECURITY;`,
  `ALTER TABLE property_pickups ADD COLUMN IF NOT EXISTS page_image_url TEXT;`,
  `ALTER TABLE property_pickups ADD COLUMN IF NOT EXISTS image_lines JSONB;`,
  `ALTER TABLE property_pickups ADD COLUMN IF NOT EXISTS image_facts JSONB;`,
  `CREATE TABLE IF NOT EXISTS property_pickup_notes (
     id BIGSERIAL PRIMARY KEY,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     property_customer_id UUID NOT NULL,
     batch_id TEXT,
     text TEXT NOT NULL,
     author TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS idx_property_pickup_notes_customer ON property_pickup_notes(property_customer_id, created_at DESC);`,
  `ALTER TABLE property_pickup_notes DISABLE ROW LEVEL SECURITY;`,
  `ALTER TABLE region_map ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;`,
  `ALTER TABLE station_map ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;`,
  `UPDATE region_map SET priority = 100 WHERE source = 'manual' AND priority = 0;`,
  `UPDATE station_map SET priority = 100 WHERE source = 'manual' AND priority = 0;`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

async function main() {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `⚠ ${error.message}\n   ${sql.slice(0, 60)}` : `✅ ${sql.split("\n")[0].slice(0, 70)}`);
  }
  const { error } = await sb.from("property_pickups").select("id").limit(1);
  console.log(error ? `⚠ 読めない: ${error.message}` : "✅ property_pickups を読める");
}
main().catch((e) => { console.error(e); process.exit(1); });
