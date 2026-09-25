// 検索の点検（2026-09-25 竹内）の本番DB: search_audits（1回ごと）と search_audit_causes（原因ごと）。
// migrate-schema/route.ts と同じ DDL。
// 実行: npx tsx --env-file=.env.local scripts/apply-search-audits.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `CREATE TABLE IF NOT EXISTS search_audits (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'finished', 'abandoned')),
  property_customer_id TEXT,
  site TEXT,
  mode TEXT CHECK (mode IS NULL OR mode IN ('brain_normal', 'brain_staff', 'brain_aix')),
  trigger TEXT CHECK (trigger IS NULL OR trigger IN ('bulk_queue', 'bulk_manual', 'single', 'scrape_compare', 'web_brain')),
  command_id TEXT,
  is_wide BOOLEAN,
  area_mode TEXT,
  pass TEXT,
  customer_snapshot JSONB,
  intended JSONB,
  filled JSONB,
  steps JSONB,
  result JSONB,
  error TEXT,
  error_kind TEXT,
  page_url TEXT,
  ext_version TEXT,
  checks JSONB,
  severity TEXT CHECK (severity IS NULL OR severity IN ('ok', 'warn', 'bad')),
  cause_key TEXT,
  ai_status TEXT,
  ai_diagnosis JSONB
);`,
  `CREATE INDEX IF NOT EXISTS idx_search_audits_created ON search_audits(created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_search_audits_started ON search_audits(created_at) WHERE status = 'started';`,
  `CREATE INDEX IF NOT EXISTS idx_search_audits_ai_pending ON search_audits(created_at) WHERE ai_status = 'pending';`,
  `CREATE INDEX IF NOT EXISTS idx_search_audits_cause ON search_audits(cause_key, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_search_audits_customer ON search_audits(property_customer_id, created_at DESC);`,
  `ALTER TABLE search_audits DISABLE ROW LEVEL SECURITY;`,
  `CREATE TABLE IF NOT EXISTS search_audit_causes (
  cause_key TEXT PRIMARY KEY,
  title TEXT,
  site TEXT,
  count_7d INTEGER NOT NULL DEFAULT 0,
  count_total INTEGER NOT NULL DEFAULT 0,
  first_seen TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  example_run_ids TEXT[],
  fix_hint TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed', 'ignored')),
  fixed_in_version TEXT,
  fixed_at TIMESTAMPTZ,
  note TEXT
);`,
  `CREATE INDEX IF NOT EXISTS idx_search_audit_causes_last_seen ON search_audit_causes(last_seen DESC);`,
  `ALTER TABLE search_audit_causes DISABLE ROW LEVEL SECURITY;`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

(async () => {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `NG ${error.message}` : "OK", sql.replace(/\s+/g, " ").slice(0, 90));
  }
  await new Promise((r) => setTimeout(r, 2000));
  const a = await sb.from("search_audits").select("run_id, status, checks, ai_status").limit(1);
  console.log("select search_audits:", a.error ? `NG ${a.error.message}` : "OK");
  const b = await sb.from("search_audit_causes").select("cause_key, status, fixed_at").limit(1);
  console.log("select search_audit_causes:", b.error ? `NG ${b.error.message}` : "OK");
})();
