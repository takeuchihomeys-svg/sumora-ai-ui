/**
 * learn_supervisor_log を作る（2026-11-14 竹内さん承認）
 * 実行: npx tsx --env-file=.env.local scripts/apply-supervisor-log.ts
 */
import { supabase as sb } from "../app/lib/supabase-server";

const STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS learn_supervisor_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scope TEXT NOT NULL DEFAULT 'all',
  verdict TEXT NOT NULL,
  headline TEXT,
  coverage INTEGER NOT NULL DEFAULT 0,
  weak_n INTEGER NOT NULL DEFAULT 0,
  next_n INTEGER NOT NULL DEFAULT 0,
  points_n INTEGER NOT NULL DEFAULT 0,
  opens_n INTEGER NOT NULL DEFAULT 0,
  screens_n INTEGER NOT NULL DEFAULT 0,
  sequence_n INTEGER NOT NULL DEFAULT 0,
  with_ops INTEGER NOT NULL DEFAULT 0,
  guessed_opens INTEGER NOT NULL DEFAULT 0,
  rows INTEGER NOT NULL DEFAULT 0,
  delta JSONB,
  actions JSONB,
  meeting JSONB,
  block TEXT,
  bundle_at TIMESTAMPTZ
)`,
  `CREATE INDEX IF NOT EXISTS idx_learn_supervisor_scope ON learn_supervisor_log(scope, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_learn_supervisor_created ON learn_supervisor_log(created_at DESC)`,
  `ALTER TABLE learn_supervisor_log ENABLE ROW LEVEL SECURITY`,
  `COMMENT ON TABLE learn_supervisor_log IS '学習の統括の判断（結論・材料の揃い・弱い所・次にやる事・打ち合わせの内容）を1回ごとに1行。数と判断だけ。2026-11-14 竹内さん承認'`,
  `SELECT pg_notify('pgrst', 'reload schema')`,
];

void (async () => {
  let ng = 0;
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    if (error) ng++;
    console.log(error ? `NG ${error.message}` : "OK", sql.replace(/\s+/g, " ").slice(0, 90));
  }
  await new Promise((r) => setTimeout(r, 2500));
  const a = await sb.from("learn_supervisor_log").select("id, scope, verdict, coverage").limit(1);
  console.log("select:", a.error ? `NG ${a.error.message}` : `OK（行 ${a.data ? a.data.length : 0}）`);
  console.log(ng === 0 && !a.error ? "全部 OK" : `NG ${ng} 件`);
})();
