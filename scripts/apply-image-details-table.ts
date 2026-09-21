// image_details を本番DBに作る（migrate-schema/route.ts と同じ DDL を1つだけ流す）
// 2026-09-21 竹内「引用先の画像を読み取れるように」
// 実行: npx tsx --env-file=.env.local scripts/apply-image-details-table.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `CREATE TABLE IF NOT EXISTS image_details (
     image_url TEXT PRIMARY KEY,
     conversation_id TEXT,
     kind TEXT NOT NULL DEFAULT 'other',
     lines JSONB NOT NULL DEFAULT '[]'::jsonb,
     model TEXT,
     read_at TIMESTAMPTZ DEFAULT now()
   );`,
  `CREATE INDEX IF NOT EXISTS idx_image_details_conv ON image_details(conversation_id);`,
  `ALTER TABLE image_details DISABLE ROW LEVEL SECURITY;`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

async function main() {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `⚠ ${error.message}\n   ${sql.slice(0, 60)}` : `✅ ${sql.split("\n")[0].slice(0, 60)}`);
  }
  const { error } = await sb.from("image_details").select("image_url").limit(1);
  console.log(error ? `⚠ 読めない: ${error.message}` : "✅ image_details を読める");
}
main().catch((e) => { console.error(e); process.exit(1); });
