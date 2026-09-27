// aix_usage_logs.picker_choices（画面で選んだピッカー・入力値）を本番DBに作る（migrate-schema/route.ts と同じ DDL）
// 2026-09-27 竹内「ピッカー選択した部分の記録はない状態なのか／無ければそこも作っておく」
// 実行: npx tsx --env-file=.env.local scripts/apply-aix-picker-choices-column.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS picker_choices JSONB DEFAULT NULL;`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

(async () => {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `NG ${error.message}` : "OK", sql.slice(0, 80));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const a = await sb.from("aix_usage_logs").select("id, picker_choices").limit(1);
  console.log("select aix_usage_logs.picker_choices:", a.error ? `NG ${a.error.message}` : "OK");
})();
