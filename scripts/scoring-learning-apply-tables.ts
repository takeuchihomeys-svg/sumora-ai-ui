// scoring_weights（物件の点の重みの版）・scoring_learning_runs（週1回の学習の結果）を本番DBに作る
// （migrate-schema/route.ts と同じ DDL）
// 2026-09-25 竹内「自動的に学習されていく仕組みを作る。判定基準をより精度高くしていくために」
// 実行: npx tsx --env-file=.env.local scripts/scoring-learning-apply-tables.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `CREATE TABLE IF NOT EXISTS scoring_weights (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','retired','rejected')),
  weights JSONB NOT NULL DEFAULT '{}',
  base_version INTEGER,
  source TEXT NOT NULL DEFAULT 'learning',
  run_id BIGINT,
  note TEXT,
  activated_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_scoring_weights_active ON scoring_weights((status)) WHERE status = 'active';`,
  `ALTER TABLE scoring_weights DISABLE ROW LEVEL SECURITY;`,
  `CREATE TABLE IF NOT EXISTS scoring_learning_runs (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dry BOOLEAN NOT NULL DEFAULT false,
  data_until TIMESTAMPTZ,
  days INTEGER,
  episodes_total INTEGER,
  train_n INTEGER,
  holdout_n INTEGER,
  counts JSONB,
  active_version INTEGER,
  metrics JSONB,
  feature_stats JSONB,
  segment_stats JSONB,
  code_stats JSONB,
  proposal JSONB,
  holdout_base JSONB,
  holdout_proposed JSONB,
  improved BOOLEAN NOT NULL DEFAULT false,
  decision TEXT,
  proposed_version INTEGER,
  auto_applied BOOLEAN NOT NULL DEFAULT false,
  auto_reason TEXT
);`,
  `CREATE INDEX IF NOT EXISTS idx_scoring_learning_runs_created ON scoring_learning_runs(created_at DESC);`,
  `ALTER TABLE scoring_learning_runs DISABLE ROW LEVEL SECURITY;`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

(async () => {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `NG ${error.message}` : "OK", sql.replace(/\s+/g, " ").slice(0, 80));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const a = await sb.from("scoring_weights").select("id, version, status, weights").limit(1);
  console.log("select scoring_weights:", a.error ? `NG ${a.error.message}` : "OK");
  const b = await sb.from("scoring_learning_runs").select("id, improved, proposal").limit(1);
  console.log("select scoring_learning_runs:", b.error ? `NG ${b.error.message}` : "OK");
})();
