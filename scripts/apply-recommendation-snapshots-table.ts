// recommendation_snapshots（🌟を送った時点の候補一覧）・property_candidate_pools.facts_version / enriched_at・sent_image_properties.facts を本番DBに作る
// （migrate-schema/route.ts と同じ DDL）
// 2026-09-25 竹内「候補の記憶を太くする。会話を見たりオススメしている部分を見ればギャップが分かる」
// 実行: npx tsx --env-file=.env.local scripts/apply-recommendation-snapshots-table.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `ALTER TABLE property_candidate_pools ADD COLUMN IF NOT EXISTS facts_version INTEGER;`,
  `ALTER TABLE property_candidate_pools ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;`,
  `CREATE TABLE IF NOT EXISTS recommendation_snapshots (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aix_usage_log_id UUID,
  message_id TEXT,
  conversation_id TEXT NOT NULL,
  property_customer_id UUID,
  sent_at TIMESTAMPTZ NOT NULL,
  star_name TEXT,
  star_room TEXT,
  star_text TEXT,
  star_in_candidates BOOLEAN NOT NULL DEFAULT false,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  candidates JSONB NOT NULL DEFAULT '[]',
  star_text_facts JSONB,
  appeal_topics TEXT[],
  customer_wants JSONB,
  pool_ids TEXT[],
  pickup_batch_ids TEXT[],
  source TEXT NOT NULL DEFAULT 'live',
  facts_v INTEGER
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_rec_snap_aix_log ON recommendation_snapshots(aix_usage_log_id) WHERE aix_usage_log_id IS NOT NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_rec_snap_message ON recommendation_snapshots(message_id) WHERE message_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_rec_snap_conv ON recommendation_snapshots(conversation_id, sent_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_rec_snap_customer ON recommendation_snapshots(property_customer_id, sent_at DESC);`,
  `ALTER TABLE recommendation_snapshots DISABLE ROW LEVEL SECURITY;`,
  // 送った画像1枚ごとの値（2026-09-25 追加の指示）
  `ALTER TABLE sent_image_properties ADD COLUMN IF NOT EXISTS facts JSONB;`,
  `ALTER TABLE sent_image_properties ADD COLUMN IF NOT EXISTS facts_read_at TIMESTAMPTZ;`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

(async () => {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `NG ${error.message}` : "OK", sql.replace(/\s+/g, " ").slice(0, 80));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const a = await sb.from("recommendation_snapshots").select("id, candidates, customer_wants").limit(1);
  console.log("select recommendation_snapshots:", a.error ? `NG ${a.error.message}` : "OK");
  const b = await sb.from("property_candidate_pools").select("id, facts_version, enriched_at").limit(1);
  console.log("select property_candidate_pools.facts_version:", b.error ? `NG ${b.error.message}` : "OK");
  const c = await sb.from("sent_image_properties").select("image_url, facts, facts_read_at").limit(1);
  console.log("select sent_image_properties.facts:", c.error ? `NG ${c.error.message}` : "OK");
})();
