// property_sheet_facts（画像で分析の物件ごとの事実）を本番DBに作る（migrate-schema/route.ts と同じ DDL）
// 2026-09-24 竹内「読んだ結果を物件ごとに保存し、2回目以降は画像を読み直さない（希望との照合は文字だけ）」
// 実行: npx tsx --env-file=.env.local scripts/apply-property-sheet-facts-table.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `CREATE TABLE IF NOT EXISTS property_sheet_facts (
     id BIGSERIAL PRIMARY KEY,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     unit_key TEXT,
     site TEXT,
     sheet_type TEXT NOT NULL,
     crop_mode TEXT NOT NULL,
     crop_basis TEXT,
     fp_hash TEXT,
     image_facts JSONB,
     text_facts JSONB,
     consistency JSONB,
     model TEXT,
     prompt_version TEXT NOT NULL,
     reused_from BIGINT,
     source_pickup_id BIGINT
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_property_sheet_facts_unit ON property_sheet_facts(unit_key, prompt_version);`,
  `CREATE INDEX IF NOT EXISTS idx_property_sheet_facts_fp ON property_sheet_facts(fp_hash, prompt_version);`,
  `ALTER TABLE property_sheet_facts DISABLE ROW LEVEL SECURITY;`,
  // 2026-09-24 夜: 希望の文字の照合（DeepSeek）の答えを物件ごとに保存し、2回目は呼ばない（{ 希望の文: {result, why} }）
  `ALTER TABLE property_sheet_facts ADD COLUMN IF NOT EXISTS wants_judged JSONB;`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

(async () => {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `NG ${error.message}` : "OK", sql.slice(0, 70).replace(/\s+/g, " "));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const { error } = await sb.from("property_sheet_facts").select("id").limit(1);
  console.log("select:", error ? `NG ${error.message}` : "OK");
})();
