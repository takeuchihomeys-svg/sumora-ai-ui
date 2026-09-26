// 「申込期間のまとめ（個人情報なし）」の本番DB: apply_period_summaries（migrate-schema/route.ts と同じ DDL）
//
// 実行: npx tsx --env-file=.env.local scripts/apply-apply-period-summaries.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

// migrate-schema/route.ts の「apply_period_summaries」節と同じ文（変える時は両方）
const STMTS = [
  `CREATE TABLE IF NOT EXISTS apply_period_summaries (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  cutoff_at TIMESTAMPTZ NOT NULL,
  period_start TIMESTAMPTZ,
  status TEXT NOT NULL,
  block TEXT,
  summary_json JSONB,
  reject_reasons TEXT[],
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  message_count INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`,
  `ALTER TABLE apply_period_summaries DISABLE ROW LEVEL SECURITY;`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

async function main() {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `NG ${error.message}` : "OK", sql.replace(/\s+/g, " ").slice(0, 80));
  }
  await new Promise((r) => setTimeout(r, 2500));
  const chk = await sb.from("apply_period_summaries").select("conversation_id").limit(1);
  console.log("select apply_period_summaries:", chk.error ? `NG ${chk.error.message}` : "OK");
}
main().catch((e) => { console.error(e); process.exit(1); });
