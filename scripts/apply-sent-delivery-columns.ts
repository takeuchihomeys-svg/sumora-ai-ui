// sent_properties に delivery / channel / pickup_id、sent_image_properties に channel を足す（migrate-schema/route.ts と同じ DDL）
// 2026-09-24 竹内「どれ物件ピックアップで送ったか物件オススメで送ったかもわかる」
// ⚠ ここには ADD COLUMN IF NOT EXISTS と CREATE INDEX IF NOT EXISTS だけを置く（既存の行は書き換えない。埋め戻しは scripts/backfill-sent-delivery.ts）
// 実行: npx tsx --env-file=.env.local scripts/apply-sent-delivery-columns.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `ALTER TABLE sent_properties ADD COLUMN IF NOT EXISTS delivery TEXT;`,
  `ALTER TABLE sent_properties ADD COLUMN IF NOT EXISTS channel TEXT;`,
  `ALTER TABLE sent_properties ADD COLUMN IF NOT EXISTS pickup_id BIGINT;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_sent_props_pickup ON sent_properties(pickup_id) WHERE pickup_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_sent_props_image_url ON sent_properties(image_url) WHERE image_url IS NOT NULL;`,
  `ALTER TABLE sent_image_properties ADD COLUMN IF NOT EXISTS channel TEXT;`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

async function main() {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `⚠ ${error.message}\n   ${sql.slice(0, 70)}` : `✅ ${sql.slice(0, 90)}`);
  }
  // PostgREST のスキーマの読み直しを少し待ってから確かめる
  await new Promise((r) => setTimeout(r, 2000));
  const a = await sb.from("sent_properties").select("id, delivery, channel, pickup_id").limit(1);
  console.log(a.error ? `⚠ sent_properties の新しい列を読めない: ${a.error.message}` : "✅ sent_properties.delivery / channel / pickup_id を読める");
  const b = await sb.from("sent_image_properties").select("image_url, channel").limit(1);
  console.log(b.error ? `⚠ sent_image_properties.channel を読めない: ${b.error.message}` : "✅ sent_image_properties.channel を読める");
}
main().catch((e) => { console.error(e); process.exit(1); });
