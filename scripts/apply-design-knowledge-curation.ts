// 設計知見の整理の列（retired_reason・superseded_by・retired_at・retired_by）と design_rules_digest を本番DBに作る（migrate-schema/route.ts と同じ DDL）
// 2026-10-06 竹内「設計知見の更新や成長はツールを完成させるにあたってかなり重要」（⑯）
// 実行: npx tsx --env-file=.env.local scripts/apply-design-knowledge-curation.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `ALTER TABLE system_design_thinking ADD COLUMN IF NOT EXISTS retired_reason TEXT;`,
  `ALTER TABLE system_design_thinking ADD COLUMN IF NOT EXISTS superseded_by UUID;`,
  `ALTER TABLE system_design_thinking ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;`,
  `ALTER TABLE system_design_thinking ADD COLUMN IF NOT EXISTS retired_by TEXT;`,
  `COMMENT ON COLUMN system_design_thinking.retired_reason IS '非現行にした理由（重複・竹内さんの決定で古くなった 等）';`,
  `COMMENT ON COLUMN system_design_thinking.superseded_by IS 'この行を上書きした新しい行の id（重複なら残した行）';`,
  `COMMENT ON COLUMN system_design_thinking.retired_at IS '非現行にした時刻';`,
  `COMMENT ON COLUMN system_design_thinking.retired_by IS '非現行にした仕組み（kb-curate:duplicate／kb-curate:decision／kb-retire 等）';`,
  `CREATE TABLE IF NOT EXISTS design_rules_digest (area TEXT PRIMARY KEY, markdown TEXT NOT NULL, row_ids UUID[] NOT NULL DEFAULT '{}', review JSONB, generated_at TIMESTAMPTZ NOT NULL DEFAULT now());`,
  `ALTER TABLE design_rules_digest DISABLE ROW LEVEL SECURITY;`,
  `COMMENT ON TABLE design_rules_digest IS '設計知見の分野ごとの今の決まり（現行の行だけ・元の行の id 付き）。/api/cron/design-knowledge と scripts/kb-curate.ts が作る';`,
  `COMMENT ON COLUMN design_rules_digest.review IS '要確認の一覧（area=要確認 の行だけ）: [{kind, ids, relation, note}]';`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

(async () => {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `NG ${error.message}` : "OK", sql.slice(0, 80));
  }
  await new Promise((r) => setTimeout(r, 2000));
  const a = await sb.from("system_design_thinking").select("id, retired_reason, superseded_by, retired_at, retired_by").limit(1);
  console.log("select system_design_thinking の新しい列:", a.error ? `NG ${a.error.message}` : "OK");
  const b = await sb.from("design_rules_digest").select("area").limit(1);
  console.log("select design_rules_digest:", b.error ? `NG ${b.error.message}` : "OK");
})();
