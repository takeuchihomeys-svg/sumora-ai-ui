-- scripts/sql/rag-index-1118.sql — RAG の RPC がディスクを読みすぎる（Disk IO の枠の使い切り）を直す DDL の案（作業員H・2026-11-18）
-- ⚠ まだ当てていない。当てるのは JST 22時以降・統括役の OK の後。1段ずつ流し、段ごとに rag_call_logs の ms と Supabase の Disk IO を見る。
--   CONCURRENTLY は transaction の中では動かない＝MCP の apply_migration ではなく、1文ずつ execute_sql で流す。
--
-- 調べた事（軽い読みだけ: pg_indexes・pg_relation_size・pg_stats・EXPLAIN（ANALYZE なし））:
--   winning_patterns       41行なのに ivfflat の索引 68MB・TOAST 34MB（更新の繰り返しで膨らんだ）。関数が ivfflat.probes=100＝膨らんだ索引を毎回全部読む（1回 約35MB）。
--   ⚠ 4つの関数とも SET ivfflat.probes TO '100' が付いている（pg_get_functiondef で確かめた）。
--   ai_reply_examples      ivfflat 104MB（lists=100）。match_reply_examples が SET ivfflat.probes=100＝100 の箱を全部読む＝毎回ほぼ全部（1回 約44MB）。
--                          match_aix_reply_examples も同じ索引（probes は既定）。
--   ai_reply_knowledge     match_reply_knowledge の ORDER BY が COALESCE(embedding_h <=> q, embedding <=> q) − boost の式＝索引が使えず全行を読む
--                          （EXPLAIN: Seq Scan on ai_reply_knowledge・約1.4万行・表 79MB＋TOAST 140MB）。ivfflat 224MB は一度も使われていない。
--   rag_call_logs（24時間）: match_reply_knowledge 153回 平均 3.5秒／match_reply_examples 47回 5.6秒／match_aix_reply_examples 10回 8.0秒。

-- ── 段1: winning_patterns（41行・索引は要らない＝全行で 0.3MB）────────────────
DROP INDEX CONCURRENTLY IF EXISTS winning_patterns_embedding_idx;
VACUUM (ANALYZE) winning_patterns;

-- ── 段2: ai_reply_knowledge（半精度の embedding_h に HNSW・関数を索引に合う形に）──────
-- 2-1 embedding_h が無い行（pg_stats の null_frac 0.0001＝2行ほど）を埋める
UPDATE ai_reply_knowledge SET embedding_h = embedding::halfvec(1536) WHERE embedding_h IS NULL AND embedding IS NOT NULL;
-- 2-2 HNSW（halfvec の cosine）。1.7万行×3KB＝約50MB＋グラフ
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_reply_knowledge_embedding_h_hnsw ON ai_reply_knowledge USING hnsw (embedding_h halfvec_cosine_ops);
-- 2-3 関数: 先に索引で近い順に候補（match_count×5）を取り、その中で boost を当てて並べ直す（結果の形・引数は今と同じ）
CREATE OR REPLACE FUNCTION match_reply_knowledge(query_embedding vector, match_count integer, min_importance integer DEFAULT 7, boost_state text DEFAULT NULL::text)
RETURNS TABLE(id uuid, title text, content text, category text, conversation_state text, importance integer, similarity double precision, hypothesis_status text, created_at timestamp with time zone, source text)
LANGUAGE sql STABLE
SET hnsw.ef_search TO '100'
SET hnsw.iterative_scan TO 'relaxed_order'
AS $function$
  WITH cand AS MATERIALIZED (
    SELECT ak.id, (ak.embedding_h <=> query_embedding::halfvec(1536)) AS d
    FROM ai_reply_knowledge ak
    WHERE ak.embedding_h IS NOT NULL AND ak.importance >= min_importance
      AND COALESCE(ak.hypothesis_status, 'hypothesis') != 'rejected'
    ORDER BY ak.embedding_h <=> query_embedding::halfvec(1536)
    LIMIT GREATEST(match_count, 1) * 5
  )
  SELECT ak.id, ak.title, ak.content, ak.category, ak.conversation_state, ak.importance,
         (1 - c.d)::float AS similarity, ak.hypothesis_status, ak.created_at, ak.source
  FROM cand c JOIN ai_reply_knowledge ak ON ak.id = c.id
  ORDER BY c.d - CASE WHEN boost_state IS NOT NULL AND ak.conversation_state = boost_state THEN 0.03 ELSE 0 END
  LIMIT match_count
$function$;
-- 2-4 使われていない ivfflat を外す（224MB）
DROP INDEX CONCURRENTLY IF EXISTS ai_reply_knowledge_embedding_idx;

-- ── 段3: ai_reply_examples（HNSW に替えて probes=100 の全読みをやめる）──────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_reply_examples_embedding_hnsw ON ai_reply_examples USING hnsw (embedding vector_cosine_ops);
-- 3-1 返信の手本（絞り込みの後で足りなくならないよう iterative_scan・外側で近い順に並べ直す）
CREATE OR REPLACE FUNCTION match_reply_examples(query_embedding vector, match_count integer, filter_states text[])
RETURNS TABLE(id uuid, customer_message text, sent_reply text, conversation_state text, is_starred boolean, reply_angle text, customer_intent text, similarity double precision)
LANGUAGE sql STABLE
SET hnsw.ef_search TO '100'
SET hnsw.iterative_scan TO 'relaxed_order'
AS $function$
  WITH cand AS MATERIALIZED (
    SELECT ae.id, ae.customer_message, ae.sent_reply, ae.conversation_state, ae.is_starred, ae.reply_angle, ae.customer_intent,
           (ae.embedding <=> query_embedding) AS d
    FROM ai_reply_examples ae
    WHERE ae.conversation_state = ANY(filter_states) AND ae.embedding IS NOT NULL AND ae.entry_source = 'line_reply'
    ORDER BY ae.embedding <=> query_embedding
    LIMIT match_count
  )
  SELECT id, customer_message, sent_reply, conversation_state, is_starred, reply_angle, customer_intent, (1 - d)::float AS similarity
  FROM cand ORDER BY d
$function$;
-- 3-2 AIX の手本（同じ形）
CREATE OR REPLACE FUNCTION match_aix_reply_examples(query_embedding vector, match_count integer, filter_action text DEFAULT NULL::text)
RETURNS TABLE(id uuid, customer_message text, sent_reply text, conversation_state text, is_starred boolean, reply_angle text, aix_action text, outcome_status text, similarity double precision)
LANGUAGE sql STABLE
SET hnsw.ef_search TO '100'
SET hnsw.iterative_scan TO 'relaxed_order'
AS $function$
  WITH cand AS MATERIALIZED (
    SELECT ae.id, ae.customer_message, ae.sent_reply, ae.conversation_state, ae.is_starred, ae.reply_angle, ae.aix_action, ae.outcome_status,
           (ae.embedding <=> query_embedding) AS d
    FROM ai_reply_examples ae
    WHERE ae.entry_source IN ('aix_template', 'aix_action', 'aix_property') AND ae.embedding IS NOT NULL
    ORDER BY ae.embedding <=> query_embedding
    LIMIT match_count
  )
  -- 今の定義と同じ: filter_action は絞り込みではなく似た度に +0.05（並びは距離の順のまま）
  SELECT id, customer_message, sent_reply, conversation_state, is_starred, reply_angle, aix_action, outcome_status,
         CASE WHEN filter_action IS NOT NULL AND aix_action = filter_action THEN (1 - d)::float + 0.05 ELSE (1 - d)::float END AS similarity
  FROM cand ORDER BY d
$function$;
-- 3-3 古い ivfflat を外す（104MB）
DROP INDEX CONCURRENTLY IF EXISTS idx_ai_reply_examples_embedding;

-- ── 段4（任意）: 決まりの読み（category＋importance）を1本の索引で ─────────────────
-- 本番で多い読み: category=eq.principle&importance=gte.9 order importance desc（163回/9時間）等
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_reply_knowledge_cat_imp ON ai_reply_knowledge (category, importance DESC, created_at DESC);

-- 確かめ（当てた後）: rag_call_logs の ms の中央値（段ごとの前後）・Supabase の Disk IO・scripts/rag-precision.ts で近い順が大きく変わっていないか
-- 戻し方: 関数は今の定義（pg_get_functiondef で控えてから）に CREATE OR REPLACE で戻す。ivfflat は CREATE INDEX CONCURRENTLY で作り直せる
-- migrate-schema/route.ts への反映は当てて確かめた後（絶対ルール4）
