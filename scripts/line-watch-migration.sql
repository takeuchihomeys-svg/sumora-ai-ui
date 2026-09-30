-- scripts/line-watch-migration.sql
-- LINE の見張り 1段目（2026-10-01 竹内「LINE の監視の部分にうつる、自動で行って YUMA でテスト」・設計 line-watch-design.md §3.1・§8）
-- 本番に流す SQL（作成・止め方・外し方）。作成の部分は app/api/migrate-schema/route.ts に同じ文で入っている（CLAUDE.md 絶対ルール4）。
--
-- ⚠ この SQL は JS のテンプレート文字列にも貼るので、バックスラッシュ・バッククォート・「ドル記号＋波括弧」を使わない
--   （正規表現は POSIX の [[:space:]] と [[] []] で書く）。
-- 確かめ: scripts/line-watch-trigger-selftest.mjs（PGlite＝本物の Postgres で「トリガーの中で何が失敗しても元の更新が通る」を当てる）

-- ════════════════════════════════════════════════════════════════════
-- 1. 作成（何度流しても同じ結果・既存の行は消さない）
-- ════════════════════════════════════════════════════════════════════

-- line_watch_settings: 見張りの設定（1行だけ）。capture_enabled=false でトリガーは何もしない（最初に読む）
CREATE TABLE IF NOT EXISTS line_watch_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  capture_enabled BOOLEAN NOT NULL DEFAULT true,
  note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO line_watch_settings (id, capture_enabled) VALUES (1, true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE line_watch_settings DISABLE ROW LEVEL SECURITY;

-- line_watch_turns: お客様の番1つにつき1行（「その時 AI が出していた案」の控え）。
--   番の鍵 = 連投の最初のお客様の発言（最後のスタッフの発言より後で一番古い物）。連投が続くと customer_last_at だけ進む（同じ行）。
--   案（1段目・トリガーが書く）: 下書きの最初と最後・作り直した回数・印（[AIX誘導中] 等）・ブレインの判断・最終チェックの指摘（段つきで小さく）・検索の手掛かり
--   実際（2段目の cron が書く）・自動（3段目〜）の列は今は空
--   ※ 外部キーは付けない（トリガーを軽く・会話を消す時に止めない）。消えた会話の行は2段目の掃除で消す
CREATE TABLE IF NOT EXISTS line_watch_turns (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  customer_turn_at TIMESTAMPTZ NOT NULL,
  customer_last_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  conv_status TEXT,
  draft_first TEXT,
  draft_first_at TIMESTAMPTZ,
  draft_last TEXT,
  draft_last_at TIMESTAMPTZ,
  draft_versions INT NOT NULL DEFAULT 0,
  draft_sentinel TEXT,
  draft_sentinel_at TIMESTAMPTZ,
  brain_action TEXT,
  brain_check_pattern TEXT,
  brain_reply_mode TEXT,
  brain_analyzed_msg_ts TIMESTAMPTZ,
  scene_evidence TEXT,
  brain_at TIMESTAMPTZ,
  brain_versions INT NOT NULL DEFAULT 0,
  search_hint JSONB,
  tpo_label TEXT,
  scene_key TEXT,
  final_check JSONB,
  final_check_at TIMESTAMPTZ,
  staff_first_at TIMESTAMPTZ,
  staff_texts JSONB,
  staff_aix JSONB,
  decision_id UUID,
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('same', 'same_meaning', 'partial', 'different', 'na')),
  verdict_detail JSONB,
  draft_ready_before_staff BOOLEAN,
  evaluated_at TIMESTAMPTZ,
  auto_eligible JSONB,
  auto_sent BOOLEAN,
  auto_review TEXT,
  UNIQUE (conversation_id, customer_turn_at)
);
CREATE INDEX IF NOT EXISTS idx_line_watch_turns_turn ON line_watch_turns(customer_turn_at DESC);
CREATE INDEX IF NOT EXISTS idx_line_watch_turns_updated ON line_watch_turns(updated_at DESC);
-- RLS は他の表と同じく無効（サーバーが公開キーで読むため・project_rls_anon_key_pending の決まり「個別の表だけ有効にしない」）
ALTER TABLE line_watch_turns DISABLE ROW LEVEL SECURITY;

-- capture_line_watch_turn: conversations の ai_draft・ai_draft_check・suggested_aix_meta が変わった時に番の行へ控える。
--   安全の決まり（最重要）: 中で何が失敗しても元の更新（conversations）を止めない
--   ①全体を BEGIN … EXCEPTION WHEN OTHERS（＋ query_canceled）で包み、警告を出して何もしない
--   ②行ロックの待ちは 200ms まで（lock_timeout・待てなければ控えを諦める）
--   ③重い処理なし: messages を会話の索引で2回引くだけ・JSON は小さく切る（下書き 4,000字・指摘 30件・証拠 120字）
--   ④SECURITY DEFINER（公開キーの更新でも表の権限・RLS に左右されない）・search_path 固定
--   ⑤AFTER トリガー（元の行は書き換えない・戻り値は使われない）
CREATE OR REPLACE FUNCTION capture_line_watch_turn()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET lock_timeout = '200ms' AS $$
DECLARE
  v_enabled BOOLEAN;
  v_last_staff TIMESTAMPTZ;
  v_turn TIMESTAMPTZ;
  v_last_cust TIMESTAMPTZ;
  v_draft TEXT;
  v_sentinel TEXT;
  v_check JSONB;
  v_fc JSONB;
  v_tpo TEXT;
  v_meta JSONB;
  v_brain BOOLEAN := false;
  v_ts TIMESTAMPTZ;
  v_hint JSONB;
BEGIN
  BEGIN
    SELECT capture_enabled INTO v_enabled FROM line_watch_settings WHERE id = 1;
    IF v_enabled IS DISTINCT FROM true THEN RETURN NULL; END IF;

    -- 番: 最後のスタッフの発言より後のお客様の発言（無ければ今は番が開いていない＝控えない）
    SELECT max(created_at) INTO v_last_staff FROM messages WHERE conversation_id = NEW.id AND sender <> 'customer';
    SELECT min(created_at), max(created_at) INTO v_turn, v_last_cust FROM messages
      WHERE conversation_id = NEW.id AND sender = 'customer' AND (v_last_staff IS NULL OR created_at > v_last_staff);
    IF v_turn IS NULL THEN RETURN NULL; END IF;

    -- 下書き（消した・空にした時は控えない。[AIX誘導中] 等の印は本文と分ける）
    IF NEW.ai_draft IS DISTINCT FROM OLD.ai_draft AND btrim(COALESCE(NEW.ai_draft, '')) <> '' THEN
      IF NEW.ai_draft ~ '^[[:space:]]*[[][^]]{1,30}[]][[:space:]]*$' THEN
        v_sentinel := left(btrim(NEW.ai_draft), 40);
      ELSE
        v_draft := left(NEW.ai_draft, 4000);
      END IF;
    END IF;

    -- 最終チェック（指摘は段 pass つきで小さく。修正前の指摘 pre は "CODE:severity" の文字列のまま＝段は記録に無い）
    v_check := NEW.ai_draft_check;
    IF v_check IS DISTINCT FROM OLD.ai_draft_check AND jsonb_typeof(v_check) = 'object' THEN
      v_fc := jsonb_build_object(
        'ok', v_check -> 'ok',
        'issues', CASE WHEN jsonb_typeof(v_check -> 'issues') = 'array' THEN (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'code', s.e ->> 'code', 'pass', s.e ->> 'pass', 'severity', s.e ->> 'severity', 'evidence', left(s.e ->> 'evidence', 120))), '[]'::jsonb)
            FROM (SELECT e FROM jsonb_array_elements(v_check -> 'issues') AS e LIMIT 30) s
          ) ELSE '[]'::jsonb END,
        'pre', CASE WHEN jsonb_typeof(v_check -> 'pre_revision_issues') = 'array' THEN v_check -> 'pre_revision_issues' END,
        'first_pass', CASE WHEN jsonb_typeof(v_check -> 'first_pass_issues') = 'array' THEN v_check -> 'first_pass_issues' END,
        'passes', v_check -> 'passes_completed',
        'pass_failures', v_check -> 'pass_failures',
        'revision_count', v_check -> 'revision_count',
        'revision_exhausted', v_check -> 'revision_exhausted',
        'regen_count', v_check -> 'regen_count',
        'revision_outcome', v_check #> '{tpo_debug,revisionOutcome}',
        'final_codes', v_check #> '{tpo_debug,finalCheckCodes}',
        'text_hash', v_check -> 'checked_text_hash',
        'elapsed_ms', v_check -> 'elapsed_ms'
      );
      v_tpo := left(v_check #>> '{tpo_debug,tpo_label}', 300);
    END IF;

    -- ブレインの判断
    v_meta := NEW.suggested_aix_meta;
    IF v_meta IS DISTINCT FROM OLD.suggested_aix_meta AND jsonb_typeof(v_meta) = 'object' THEN
      v_brain := true;
      BEGIN
        v_ts := (v_meta ->> 'analyzed_msg_ts')::timestamptz;
      EXCEPTION WHEN OTHERS THEN
        v_ts := NULL;
      END;
      v_hint := jsonb_strip_nulls(jsonb_build_object(
        'params', CASE WHEN length((v_meta -> 'property_search_params')::text) > 4000
                       THEN jsonb_build_object('too_large', length((v_meta -> 'property_search_params')::text))
                       ELSE v_meta -> 'property_search_params' END,
        'change_type', v_meta -> 'condition_change_type',
        'change_scope', v_meta -> 'condition_change_scope'));
      IF v_hint = '{}'::jsonb THEN v_hint := NULL; END IF;
    END IF;

    IF v_draft IS NULL AND v_sentinel IS NULL AND v_fc IS NULL AND NOT v_brain THEN RETURN NULL; END IF;

    INSERT INTO line_watch_turns AS t (
      conversation_id, customer_turn_at, customer_last_at, conv_status,
      draft_first, draft_first_at, draft_last, draft_last_at, draft_versions,
      draft_sentinel, draft_sentinel_at,
      brain_action, brain_check_pattern, brain_reply_mode, brain_analyzed_msg_ts, scene_evidence, brain_at, brain_versions, search_hint,
      tpo_label, final_check, final_check_at
    ) VALUES (
      NEW.id, v_turn, v_last_cust, NEW.status,
      v_draft, CASE WHEN v_draft IS NOT NULL THEN now() END,
      v_draft, CASE WHEN v_draft IS NOT NULL THEN now() END,
      CASE WHEN v_draft IS NOT NULL THEN 1 ELSE 0 END,
      v_sentinel, CASE WHEN v_sentinel IS NOT NULL THEN now() END,
      CASE WHEN v_brain THEN left(v_meta ->> 'action', 200) END,
      CASE WHEN v_brain THEN left(v_meta ->> 'check_pattern', 200) END,
      CASE WHEN v_brain THEN left(v_meta ->> 'reply_mode', 40) END,
      v_ts,
      CASE WHEN v_brain THEN left(v_meta ->> 'scene_evidence', 500) END,
      CASE WHEN v_brain THEN now() END,
      CASE WHEN v_brain THEN 1 ELSE 0 END,
      v_hint,
      v_tpo, v_fc, CASE WHEN v_fc IS NOT NULL THEN now() END
    )
    ON CONFLICT (conversation_id, customer_turn_at) DO UPDATE SET
      customer_last_at = GREATEST(t.customer_last_at, EXCLUDED.customer_last_at),
      conv_status = EXCLUDED.conv_status,
      updated_at = now(),
      draft_first = COALESCE(t.draft_first, EXCLUDED.draft_first),
      draft_first_at = COALESCE(t.draft_first_at, EXCLUDED.draft_first_at),
      draft_last = COALESCE(EXCLUDED.draft_last, t.draft_last),
      draft_last_at = COALESCE(EXCLUDED.draft_last_at, t.draft_last_at),
      draft_versions = t.draft_versions + EXCLUDED.draft_versions,
      draft_sentinel = COALESCE(EXCLUDED.draft_sentinel, t.draft_sentinel),
      draft_sentinel_at = COALESCE(EXCLUDED.draft_sentinel_at, t.draft_sentinel_at),
      brain_action = CASE WHEN EXCLUDED.brain_versions > 0 THEN EXCLUDED.brain_action ELSE t.brain_action END,
      brain_check_pattern = CASE WHEN EXCLUDED.brain_versions > 0 THEN EXCLUDED.brain_check_pattern ELSE t.brain_check_pattern END,
      brain_reply_mode = CASE WHEN EXCLUDED.brain_versions > 0 THEN EXCLUDED.brain_reply_mode ELSE t.brain_reply_mode END,
      brain_analyzed_msg_ts = CASE WHEN EXCLUDED.brain_versions > 0 THEN EXCLUDED.brain_analyzed_msg_ts ELSE t.brain_analyzed_msg_ts END,
      scene_evidence = CASE WHEN EXCLUDED.brain_versions > 0 THEN EXCLUDED.scene_evidence ELSE t.scene_evidence END,
      brain_at = COALESCE(EXCLUDED.brain_at, t.brain_at),
      brain_versions = t.brain_versions + EXCLUDED.brain_versions,
      search_hint = CASE WHEN EXCLUDED.brain_versions > 0 THEN EXCLUDED.search_hint ELSE t.search_hint END,
      tpo_label = COALESCE(EXCLUDED.tpo_label, t.tpo_label),
      final_check = COALESCE(EXCLUDED.final_check, t.final_check),
      final_check_at = COALESCE(EXCLUDED.final_check_at, t.final_check_at);
  EXCEPTION WHEN OTHERS OR query_canceled THEN
    -- 控えは諦める（元の更新は通す）。Supabase の Postgres のログに残る
    RAISE WARNING 'capture_line_watch_turn skipped: % (%)', SQLERRM, SQLSTATE;
    RETURN NULL;
  END;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_conversations_line_watch ON conversations;
CREATE TRIGGER trg_conversations_line_watch
AFTER UPDATE OF ai_draft, ai_draft_check, suggested_aix_meta ON conversations
FOR EACH ROW
WHEN (OLD.ai_draft IS DISTINCT FROM NEW.ai_draft OR OLD.ai_draft_check IS DISTINCT FROM NEW.ai_draft_check OR OLD.suggested_aix_meta IS DISTINCT FROM NEW.suggested_aix_meta)
EXECUTE FUNCTION capture_line_watch_turn();

-- ════════════════════════════════════════════════════════════════════
-- 2. 止め方（すぐ効く・表と行はそのまま）— 流す時はコメントを外す
-- ════════════════════════════════════════════════════════════════════
-- UPDATE line_watch_settings SET capture_enabled = false, note = '止めた理由', updated_at = now() WHERE id = 1;
-- 再開: UPDATE line_watch_settings SET capture_enabled = true, note = NULL, updated_at = now() WHERE id = 1;

-- ════════════════════════════════════════════════════════════════════
-- 3. 外し方（トリガーごと外す・控えた行は残る）— 流す時はコメントを外す
--    ⚠ migrate-schema を次に流すと作り直されるので、外したままにする時は route.ts の該当の節も消す
-- ════════════════════════════════════════════════════════════════════
-- DROP TRIGGER IF EXISTS trg_conversations_line_watch ON conversations;
-- DROP FUNCTION IF EXISTS capture_line_watch_turn();
-- 表まで消す時だけ（控えが全部消える）:
-- DROP TABLE IF EXISTS line_watch_turns;
-- DROP TABLE IF EXISTS line_watch_settings;

-- ════════════════════════════════════════════════════════════════════
-- 4. 流した後の確かめ（読むだけ）
-- ════════════════════════════════════════════════════════════════════
-- SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.conversations'::regclass AND NOT tgisinternal;
-- SELECT * FROM line_watch_settings;
-- SELECT conversation_id, customer_turn_at, draft_versions, brain_versions, brain_action, left(draft_last, 40), final_check -> 'issues'
--   FROM line_watch_turns ORDER BY updated_at DESC LIMIT 10;
