// 設計知見の RAG の列・関数を本番DBに作る（migrate-schema/route.ts と同じ DDL）
// 2026-10-06 竹内「設計知見ひっぱるときRAG検索いれたらどうか 設計知見かなり重要になっていく」（⑯）
// 実行: npx tsx --env-file=.env.local scripts/apply-design-knowledge-rag.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const STMTS = [
  `ALTER TABLE system_design_thinking ADD COLUMN IF NOT EXISTS embedding_hash TEXT;`,
  `COMMENT ON COLUMN system_design_thinking.embedding_hash IS 'embedding を作った文（題＋本文＋根拠＋札）の指紋。違えば埋め直す（scripts/kb-embed.ts）';`,
  `DROP INDEX IF EXISTS idx_system_design_thinking_embedding;`,
  `DROP FUNCTION IF EXISTS match_design_thinking_exact(vector, integer);`,
  `CREATE FUNCTION match_design_thinking_exact(query_embedding vector(1536), match_count INT DEFAULT 40)
RETURNS TABLE(id UUID, similarity FLOAT)
LANGUAGE sql STABLE AS $$
  SELECT dt.id, 1 - (dt.embedding <=> query_embedding) AS similarity
  FROM system_design_thinking dt
  WHERE dt.is_current = true AND dt.embedding IS NOT NULL
  ORDER BY dt.embedding <=> query_embedding
  LIMIT match_count
$$;`,
  `DROP FUNCTION IF EXISTS design_thinking_neighbors(uuid, integer, double precision);`,
  `CREATE FUNCTION design_thinking_neighbors(p_id UUID, match_count INT DEFAULT 5, min_similarity FLOAT DEFAULT 0.8)
RETURNS TABLE(id UUID, similarity FLOAT)
LANGUAGE sql STABLE AS $$
  SELECT o.id, 1 - (o.embedding <=> s.embedding) AS similarity
  FROM system_design_thinking s JOIN system_design_thinking o ON o.id <> s.id
  WHERE s.id = p_id AND s.embedding IS NOT NULL AND o.is_current = true AND o.embedding IS NOT NULL
    AND 1 - (o.embedding <=> s.embedding) >= min_similarity
  ORDER BY o.embedding <=> s.embedding
  LIMIT match_count
$$;`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];
(async () => {
  for (const sql of STMTS) { const { error } = await sb.rpc("exec_sql", { sql }); console.log(error ? `NG ${error.message}` : "OK", sql.slice(0, 70).replace(/\n/g, " ")); }
  await new Promise((r) => setTimeout(r, 2000));
  const a = await sb.from("system_design_thinking").select("id, embedding_hash").limit(1);
  console.log("select embedding_hash:", a.error ? `NG ${a.error.message}` : "OK");
  const zero = `[${new Array(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
  const b = await sb.rpc("match_design_thinking_exact", { query_embedding: zero, match_count: 3 });
  console.log("rpc match_design_thinking_exact:", b.error ? `NG ${b.error.message}` : `OK ${(b.data ?? []).length}行`);
})();
