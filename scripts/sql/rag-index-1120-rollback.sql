-- scripts/sql/rag-index-1120-rollback.sql — rag-index-1120.sql を元に戻す（作業員H・2026-11-20）
-- 1文ずつ execute_sql で流す（CONCURRENTLY は transaction の中で動かない）。
-- ⚠ migrate-schema に部分の索引を足した後に戻す時は、そのコミットも git revert する（しないと 0:10 の cron が作り直す）

-- ── 段1b を戻す（関数の計画の設定・先に戻す） ──
ALTER FUNCTION match_reply_examples(vector, integer, text[]) RESET enable_seqscan;
ALTER FUNCTION match_reply_examples(vector, integer, text[]) RESET enable_bitmapscan;
ALTER FUNCTION match_aix_reply_examples(vector, integer, text) RESET enable_seqscan;
ALTER FUNCTION match_aix_reply_examples(vector, integer, text) RESET enable_bitmapscan;
-- ── 段2 を戻す ──
DROP INDEX CONCURRENTLY IF EXISTS ai_reply_examples_line_hnsw;
-- ── 段1 を戻す ──
DROP INDEX CONCURRENTLY IF EXISTS ai_reply_examples_aix_hnsw;
-- ── 段3 を当てていたら戻す ──
DROP INDEX CONCURRENTLY IF EXISTS idx_are_line_state;
--   関数を段3 で変えていたら、11/19 の形（c3eede8c・HNSW の候補→並べ直し）に戻す。定義は SET 無しで流し、すぐ後の DO で hnsw の設定を付ける:
--   DO $$ BEGIN
--     PERFORM '[1,0]'::vector <=> '[0,1]'::vector;
--     EXECUTE 'ALTER FUNCTION match_reply_examples(vector, integer, text[]) SET hnsw.ef_search = 100';
--     EXECUTE 'ALTER FUNCTION match_reply_examples(vector, integer, text[]) SET hnsw.iterative_scan = relaxed_order';
--   END $$;
--   （定義の本文は app/api/migrate-schema/route.ts の match_reply_examples の節＝c3eede8c の時点の物）
-- 全体の索引 ai_reply_examples_embedding_hnsw は段1〜3 で消さない＝戻す物は無い
