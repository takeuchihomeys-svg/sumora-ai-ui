-- scripts/sql/rag-index-1120.sql — 手本の検索（match_reply_examples・match_aix_reply_examples）の絞り込みを索引に合わせる（作業員H・2026-11-20 の案・当てるのは 22時以降）
-- 戻す: scripts/sql/rag-index-1120-rollback.sql。1文ずつ execute_sql で流す（CONCURRENTLY は transaction の中で動かない）。
--
-- なぜ（11/19 9〜17時の本番 rag_call_logs）:
--   match_reply_examples 33回・中央値 7.5秒・失敗9／match_aix_reply_examples 15回・中央値 8.4秒・失敗10。
--   失敗は全部 57014（authenticator の statement_timeout=8s）。成功も 6〜7秒で、match_count=3 でも遅い＝外側の並べ直しではなく HNSW を引く所。
--   11/18 夜の測り（88〜195ms）は表の中の行を問いにした＝近い行がそのまま絞り込み（entry_source・conversation_state）に合っていた。
--   本番の問い（お客様の文の埋め込み）は近い行の多くが絞り込みに合わず、iterative_scan が遠くまで（hnsw.max_scan_tuples まで）読む疑い。
--   → 絞り込みと同じ条件の部分の HNSW 索引にする（索引の中の行は全部絞り込みに合う＝遠くまで読まない）。
--   ⚠ statement_timeout の8秒は変えない（統括役の決め）。
--
-- ── 段0: 測る（当てる前に1回ずつ・本番に近い問い＝embedding_cache の最近の行） ───────────────
-- 行の数（絞り込みの割合）
--   SELECT entry_source, count(*) FROM ai_reply_examples WHERE embedding IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;
--   SELECT conversation_state, count(*) FROM ai_reply_examples WHERE embedding IS NOT NULL AND entry_source='line_reply' GROUP BY 1 ORDER BY 2 DESC;
-- 本番に近い問いで EXPLAIN（ANALYZE は1回ずつ）
--   EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM match_aix_reply_examples(
--     (SELECT (embedding::text)::vector FROM embedding_cache ORDER BY created_at DESC LIMIT 1 OFFSET 3), 15, 'property_check_result');
--   EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM match_reply_examples(
--     (SELECT (embedding::text)::vector FROM embedding_cache ORDER BY created_at DESC LIMIT 1 OFFSET 3), 24, ARRAY['検討中']);
--   ※ 関数の中の計画は auto_explain が無いと見えない → 関数の本文の SELECT を同じ SET（hnsw.ef_search=100・iterative_scan=relaxed_order）で直に EXPLAIN する

-- ── 段1: AIX の手本（entry_source の3種類）の部分の HNSW ────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_reply_examples_aix_hnsw ON ai_reply_examples
  USING hnsw (embedding vector_cosine_ops) WHERE entry_source IN ('aix_template', 'aix_action', 'aix_property');
-- 関数の WHERE（entry_source IN (...)・embedding IS NOT NULL）は索引の条件を含む＝計画は部分の索引を選べる（関数は変えない）

-- ── 段2: 返信の手本（line_reply）の部分の HNSW ───────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_reply_examples_line_hnsw ON ai_reply_examples
  USING hnsw (embedding vector_cosine_ops) WHERE entry_source = 'line_reply';
-- 状態（conversation_state = ANY(filter_states)）の絞り込みは残る。段0 で状態ごとの割合が小さい（line_reply の 1割未満等）なら段3 へ

-- ── 段3（段0 の数で決める）: 状態で絞った行が少ない時は索引を使わない厳密な検索 ───────────────
--   並びの式に + 0 を付けて索引を使わせない（状態と entry_source の btree で絞った行だけ距離を測る）。
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_are_line_state ON ai_reply_examples (conversation_state) WHERE entry_source = 'line_reply' AND embedding IS NOT NULL;
--   関数の cand の ORDER BY を (ae.embedding <=> query_embedding) + 0 にする（定義は段0 の数を見てから書く・migrate-schema も同時に）

-- ── 当てた後 ───────────────────────────────────────────────────────────────
--   ・段0 と同じ EXPLAIN で部分の索引が選ばれたか・ms と buffers
--   ・rag-precision（--days=30 --limit=100）と試験（前後の同じ問題・--cap-usd=2.0）で悪化0
--   ・migrate-schema に同じ CREATE INDEX（CONCURRENTLY なし・IF NOT EXISTS）を足す（0:10 の cron で戻らない・作り直さない）
--   ・古い全体の索引 ai_reply_examples_embedding_hnsw は、両方の関数が部分の索引を使うと分かってから外すか決める（他に使う関数が無いか先に見る）
