-- scripts/sql/rag-index-1118-rollback.sql — rag-index-1118.sql を元に戻す（作業員H・2026-11-18）
-- 関数は 11/18 18:30 JST に pg_get_functiondef で控えた今の定義そのまま。索引は pg_indexes の定義そのまま（CONCURRENTLY で作り直す）。
-- 段ごとに戻せる。1文ずつ execute_sql で流す（CONCURRENTLY は transaction の中で動かない）。
-- 2026-11-19 作業員H: 関数の定義に SET "ivfflat.probes" を書くと、vector が読み込まれていない接続（execute_sql・exec_sql の1回の呼び出し）では
--   permission denied to set parameter で止まる → 定義は SET 無しで流し、すぐ後の DO ブロック（vector を読み込む同じ呼び出し）で ALTER する。
--   CREATE OR REPLACE は proconfig を丸ごと置き換える＝hnsw.ef_search・iterative_scan は CREATE の時点で消える（RESET は要らない）。
-- ⚠ 戻す時は migrate-schema（c3eede8c）も git revert する。しないと毎晩 0:10 JST の cron が ivfflat の索引を消し、HNSW の形に戻す。

-- ── 段3 を戻す: ai_reply_examples ─────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_reply_examples_embedding ON public.ai_reply_examples USING ivfflat (embedding vector_cosine_ops) WITH (lists='100');
CREATE OR REPLACE FUNCTION public.match_reply_examples(query_embedding vector, match_count integer, filter_states text[])
 RETURNS TABLE(id uuid, customer_message text, sent_reply text, conversation_state text, is_starred boolean, reply_angle text, customer_intent text, similarity double precision)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT ae.id, ae.customer_message, ae.sent_reply, ae.conversation_state, ae.is_starred, ae.reply_angle, ae.customer_intent, (1 - (ae.embedding <=> query_embedding))::float AS similarity
  FROM ai_reply_examples ae
  WHERE ae.conversation_state = ANY(filter_states)
    AND ae.embedding IS NOT NULL
    AND ae.entry_source = 'line_reply'
  ORDER BY ae.embedding <=> query_embedding
  LIMIT match_count
$function$;
DO $$ BEGIN
  PERFORM '[1,0]'::vector <=> '[0,1]'::vector;
  EXECUTE 'ALTER FUNCTION public.match_reply_examples(vector, integer, text[]) SET ivfflat.probes = 100';
END $$;
CREATE OR REPLACE FUNCTION public.match_aix_reply_examples(query_embedding vector, match_count integer, filter_action text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, customer_message text, sent_reply text, conversation_state text, is_starred boolean, reply_angle text, aix_action text, outcome_status text, similarity double precision)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    ae.id,
    ae.customer_message,
    ae.sent_reply,
    ae.conversation_state,
    ae.is_starred,
    ae.reply_angle,
    ae.aix_action,
    ae.outcome_status,
    CASE
      WHEN filter_action IS NOT NULL AND ae.aix_action = filter_action
      THEN (1 - (ae.embedding <=> query_embedding))::float + 0.05
      ELSE (1 - (ae.embedding <=> query_embedding))::float
    END AS similarity
  FROM ai_reply_examples ae
  WHERE ae.entry_source IN ('aix_template', 'aix_action', 'aix_property')
    AND ae.embedding IS NOT NULL
  ORDER BY ae.embedding <=> query_embedding
  LIMIT match_count
$function$;
DO $$ BEGIN
  PERFORM '[1,0]'::vector <=> '[0,1]'::vector;
  EXECUTE 'ALTER FUNCTION public.match_aix_reply_examples(vector, integer, text) SET ivfflat.probes = 100';
END $$;
DROP INDEX CONCURRENTLY IF EXISTS ai_reply_examples_embedding_hnsw;

-- ── 段2 を戻す: ai_reply_knowledge ────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_reply_knowledge_embedding_idx ON public.ai_reply_knowledge USING ivfflat (embedding vector_cosine_ops) WITH (lists='50');
CREATE OR REPLACE FUNCTION public.match_reply_knowledge(query_embedding vector, match_count integer, min_importance integer DEFAULT 7, boost_state text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, title text, content text, category text, conversation_state text, importance integer, similarity double precision, hypothesis_status text, created_at timestamp with time zone, source text)
 LANGUAGE sql
 STABLE
AS $function$
  -- 2026-10-18: 距離は halfvec の写し（行の中）で測る・写しが無い行だけ float（TOAST）に戻る。距離の式は似た度と並びで同じ1つ
  SELECT ak.id, ak.title, ak.content, ak.category, ak.conversation_state, ak.importance,
    (1 - COALESCE(ak.embedding_h <=> query_embedding::halfvec(1536), ak.embedding <=> query_embedding))::float AS similarity,
    ak.hypothesis_status,
    ak.created_at,
    ak.source
  FROM ai_reply_knowledge ak
  WHERE (ak.embedding_h IS NOT NULL OR ak.embedding IS NOT NULL) AND ak.importance >= min_importance
    AND COALESCE(ak.hypothesis_status, 'hypothesis') != 'rejected'
  ORDER BY COALESCE(ak.embedding_h <=> query_embedding::halfvec(1536), ak.embedding <=> query_embedding)
    - CASE WHEN boost_state IS NOT NULL AND ak.conversation_state = boost_state THEN 0.03 ELSE 0 END
  LIMIT match_count
$function$;
DO $$ BEGIN
  PERFORM '[1,0]'::vector <=> '[0,1]'::vector;
  EXECUTE 'ALTER FUNCTION public.match_reply_knowledge(vector, integer, integer, text) SET ivfflat.probes = 100';
END $$;
DROP INDEX CONCURRENTLY IF EXISTS ai_reply_knowledge_embedding_h_hnsw;
-- （embedding_h を埋めた2行ほどは戻さない＝元の embedding の写しなので結果は同じ）

-- ── 段1 を戻す: winning_patterns ──────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS winning_patterns_embedding_idx ON public.winning_patterns USING ivfflat (embedding vector_cosine_ops) WITH (lists='50');
-- （関数 match_winning_patterns は段1 で変えないので戻す物は無い。ただし毎晩の migrate-schema が probes を付けなくなったので、戻すなら下も流す）
DO $$ BEGIN
  PERFORM '[1,0]'::vector <=> '[0,1]'::vector;
  EXECUTE 'ALTER FUNCTION public.match_winning_patterns(vector, integer, text, integer) SET ivfflat.probes = 100';
END $$;
