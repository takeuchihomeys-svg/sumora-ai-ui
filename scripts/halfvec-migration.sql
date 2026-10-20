-- scripts/halfvec-migration.sql — 知識の検索（match_reply_knowledge）の時間切れを直す: halfvec の写しを行の中に持って比べる
--
-- 2026-10-18 竹内さん OK（弱い所A の案・設計知見 c60a5e07）。親が Supabase の SQL エディタで流す（本番の表に列を足す・関数を置き換える）。
--   migrate-schema（app/api/migrate-schema/route.ts）にも同じ物（列・トリガー・関数の正本・1晩500行の埋め戻し）を入れてある＝
--   このファイルは「今すぐ」用。どちらを先に流しても同じ（if not exists・CREATE OR REPLACE）。
--   なぜ: 1536次元の float 埋め込み（6KB）は TOAST に出て、冷えると重要度7以上の約7,700行を乱読みして 9.8秒（8秒で時間切れ・1日 約190回）。
--   halfvec(1536) は 3KB＝STORAGE MAIN で行の中に置ける → 順読み。本番の5問で上位100件の重なり 100/100（順位は変わらない）。
--   厳密な全件比較のまま（HNSW の近似にはしない＝厳密の決定 99e242e4 のまま）。pgvector 0.8.0（halfvec あり）を確かめ済み。

-- ── ① 列・トリガー（新しく入る知識・埋め込みの付け直しは自動で写す） ──────────────────────
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS embedding_h halfvec(1536);
ALTER TABLE ai_reply_knowledge ALTER COLUMN embedding_h SET STORAGE MAIN;
CREATE OR REPLACE FUNCTION ai_reply_knowledge_fill_embedding_h() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.embedding_h := CASE WHEN NEW.embedding IS NULL THEN NULL ELSE NEW.embedding::halfvec(1536) END;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER trg_ai_reply_knowledge_embedding_h BEFORE INSERT OR UPDATE OF embedding ON ai_reply_knowledge
  FOR EACH ROW EXECUTE FUNCTION ai_reply_knowledge_fill_embedding_h();

-- ── ② 埋め戻し（500行ずつ・「UPDATE 0」になるまで同じ文を繰り返す。約14,000行＝約29回） ──────────
--   1回 約1〜3秒（float を読むのは埋め戻しの時だけ）。表を長く鍵で止めないよう小分け。関数は③を先に入れても未埋めの行は float に戻るので壊れない
UPDATE ai_reply_knowledge SET embedding_h = embedding::halfvec(1536)
  WHERE id IN (SELECT id FROM ai_reply_knowledge WHERE embedding_h IS NULL AND embedding IS NOT NULL LIMIT 500);
-- 残り: SELECT count(*) FROM ai_reply_knowledge WHERE embedding_h IS NULL AND embedding IS NOT NULL;   … 0 になったら終わり

-- ── ③ 関数（正本は migrate-schema の「RAG の厳密化」節と同じ文・戻り値は前のまま＝CREATE OR REPLACE だけ） ──────────
CREATE OR REPLACE FUNCTION match_reply_knowledge(query_embedding vector, match_count integer, min_importance integer DEFAULT 7, boost_state text DEFAULT NULL)
RETURNS TABLE(id uuid, title text, content text, category text, conversation_state text, importance integer, similarity double precision, hypothesis_status text, created_at timestamptz, source text)
LANGUAGE sql STABLE AS $$
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
$$;
GRANT EXECUTE ON FUNCTION match_reply_knowledge(vector, integer, integer, text) TO anon, authenticated, service_role;
-- CREATE OR REPLACE は関数の SET を消す → 同じ呼び出しで vector を読み込んでから付け直す（設計知見 94cc340a）
DO $$ BEGIN
  PERFORM '[1,0]'::vector <=> '[0,1]'::vector;
  EXECUTE 'ALTER FUNCTION match_reply_knowledge(vector, integer, integer, text) SET ivfflat.probes = 100';
END $$;
-- 確かめ: SELECT proname, proconfig FROM pg_proc WHERE proname = 'match_reply_knowledge';   … {ivfflat.probes=100}

-- ── ④ 順位が変わらない事の確かめ（読むだけ・埋め戻しが終わってから） ─────────────────────────
--   問いは本番の知識の埋め込みから5つ（重要度7以上・ランダム）。旧（float だけ・厳密）と新（関数）の上位100件の重なりを数える。100/100 を期待
--   （10/18 本番で読むだけの確かめ: 3問とも 100/100。「+ 0」を付けないと旧の側が索引の近似になり 3〜51/100 と出る＝比べ方の誤り）
WITH q AS (
  SELECT id AS qid, embedding AS e FROM ai_reply_knowledge WHERE embedding IS NOT NULL AND importance >= 7 ORDER BY random() LIMIT 5
), old_top AS (
  SELECT q.qid, t.id FROM q CROSS JOIN LATERAL (
    SELECT ak.id FROM ai_reply_knowledge ak
    WHERE ak.embedding IS NOT NULL AND ak.importance >= 7 AND COALESCE(ak.hypothesis_status, 'hypothesis') != 'rejected'
    ORDER BY (ak.embedding <=> q.e) + 0 LIMIT 100) t   -- 「+ 0」で ivfflat の索引（probes=1 の近似）を使わせない＝厳密な旧の順位
), new_top AS (
  SELECT q.qid, m.id FROM q CROSS JOIN LATERAL match_reply_knowledge(q.e, 100, 7, NULL) m
)
SELECT o.qid, count(*) FILTER (WHERE n.id IS NOT NULL) AS overlap_of_100
FROM old_top o LEFT JOIN new_top n ON n.qid = o.qid AND n.id = o.id
GROUP BY o.qid;
-- 速さ（冷えた時に比べる）: EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM match_reply_knowledge((SELECT embedding FROM ai_reply_knowledge WHERE embedding IS NOT NULL LIMIT 1), 12, 7, NULL);
--   関数の中は見えないので、中の SELECT を直に EXPLAIN する（shared read が 約9万 → 約7千ページになれば効いている）

-- ── 案（本番には入れない）: match_reply_examples（ai_reply_examples 8,614行・166MB）・match_aix_reply_examples も同じ時間切れがある ──
--   同じ形: ADD COLUMN embedding_h halfvec(1536)・SET STORAGE MAIN・BEFORE INSERT OR UPDATE OF embedding のトリガー・500行ずつ埋め戻し・
--   関数の距離を COALESCE(embedding_h <=> q::halfvec(1536), embedding <=> q) に（並び・似た度・しきい値の式を全部同じ1つに）。
--   入れる前に ④ と同じ上位N件の重なりを確かめる（例文は上位8件）。表ごとに列名・関数の引数が違うので、その時に正本（migrate-schema）から写して作る

-- ── 戻す（関数を float だけに戻す・列とトリガーは残してよい＝害は無い） ─────────────────────────
-- CREATE OR REPLACE FUNCTION match_reply_knowledge(query_embedding vector, match_count integer, min_importance integer DEFAULT 7, boost_state text DEFAULT NULL)
-- RETURNS TABLE(id uuid, title text, content text, category text, conversation_state text, importance integer, similarity double precision, hypothesis_status text, created_at timestamptz, source text)
-- LANGUAGE sql STABLE AS $$
--   SELECT ak.id, ak.title, ak.content, ak.category, ak.conversation_state, ak.importance,
--     (1 - (ak.embedding <=> query_embedding))::float AS similarity, ak.hypothesis_status, ak.created_at, ak.source
--   FROM ai_reply_knowledge ak
--   WHERE ak.embedding IS NOT NULL AND ak.importance >= min_importance AND COALESCE(ak.hypothesis_status, 'hypothesis') != 'rejected'
--   ORDER BY (ak.embedding <=> query_embedding) - CASE WHEN boost_state IS NOT NULL AND ak.conversation_state = boost_state THEN 0.03 ELSE 0 END
--   LIMIT match_count
-- $$;
-- （その後 ③ の DO ブロックで probes を付け直す。migrate-schema の正本も同じ日に戻す＝毎晩の作り直しで halfvec に戻らないように）
