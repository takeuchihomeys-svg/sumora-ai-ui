import { NextResponse } from "next/server";

const SQL = `
-- conversations テーブル（LINEトーク一覧）
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  customer_name TEXT,
  status TEXT DEFAULT 'first_reply',
  line_user_id TEXT,
  last_message TEXT,
  last_sender TEXT,
  profile_image_url TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_line_user_id ON conversations(line_user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);

-- RLS を無効化: このアプリはサービスロールキーのみで接続するサーバーサイド専用のため、
-- RLS による行単位制御は不要。anon キーによるクライアント直接アクセスは想定しない。
-- セキュリティは API ルートレベルの認証（CRON_SECRET / INTERNAL_API_SECRET）で担保する。
ALTER TABLE conversations DISABLE ROW LEVEL SECURITY;

-- accountカラム（sumora / ieyasu / giga）
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS account TEXT DEFAULT 'sumora';

-- line_contacts テーブル（LINEアカウント×ユーザーの連絡先管理）
CREATE TABLE IF NOT EXISTS line_contacts (
  id BIGSERIAL PRIMARY KEY,
  line_user_id TEXT NOT NULL,
  account TEXT NOT NULL,
  line_name TEXT,
  line_profile_image TEXT,
  last_message TEXT,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(line_user_id, account)
);

CREATE INDEX IF NOT EXISTS idx_line_contacts_line_user_id ON line_contacts(line_user_id);

ALTER TABLE line_contacts DISABLE ROW LEVEL SECURITY;

-- 既存conversations.account を line_contacts から正しい値に修正
-- ※line_contacts にデータが溜まり次第、このSQLを再実行すること
UPDATE conversations c
SET account = CASE
  WHEN lc.account = 'イエヤス' THEN 'ieyasu'
  WHEN lc.account = 'ギガ賃貸' THEN 'giga'
  WHEN lc.account = 'スモラ'   THEN 'sumora'
  ELSE c.account
END
FROM line_contacts lc
WHERE c.line_user_id = lc.line_user_id
  AND c.line_user_id IS NOT NULL;

-- line_user_id の NOT NULL 制約を解除（screening-adminから同期する際にnullのケースがあるため）
ALTER TABLE conversations ALTER COLUMN line_user_id DROP NOT NULL;

-- messages テーブル（LINEメッセージ）
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  conversation_id TEXT NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('customer', 'staff')),
  text TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at ASC);

ALTER TABLE messages DISABLE ROW LEVEL SECURITY;

-- LINE公式のメッセージID（Content API 呼び出し用）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS line_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_line_message_id ON messages(line_message_id);

-- LINEリプライ（引用）機能: お客様が引用したメッセージのLINE message id
-- （物件カードへの引用リプライ → その物件への興味判定に使う。messages.line_message_id とJOINして引用先を特定）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS quoted_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_quoted_message_id ON messages(quoted_message_id);

-- AIX生成メッセージフラグ（挨拶判定から除外するため）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_aix_generated BOOLEAN DEFAULT FALSE;

-- property_customers テーブル（物件出しツール用）
CREATE TABLE IF NOT EXISTS property_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name TEXT NOT NULL,
  line_user_id TEXT,
  phone TEXT,
  status TEXT DEFAULT 'new_inquiry',
  assignee TEXT,
  area TEXT,
  max_rent INTEGER,
  layout TEXT,
  preferences TEXT,
  ng_points TEXT,
  property_memo TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Phase1: 物件出しアナウンス用カラム
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS last_property_sent_at TIMESTAMPTZ;
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS format_received BOOLEAN DEFAULT FALSE;

-- Phase2: LINEフォーマット8項目
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS move_in_time TEXT;
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS rent_min INTEGER;
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS rent_max INTEGER;
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS desired_area TEXT;
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS walk_minutes INTEGER;
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS floor_plan TEXT;
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS initial_cost_limit INTEGER;
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS building_age INTEGER;
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS other_requests TEXT;

-- updated_at 自動更新トリガー
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_property_customers_updated_at ON property_customers;
CREATE TRIGGER update_property_customers_updated_at
  BEFORE UPDATE ON property_customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- accountカラム（sumora / ieyasu / giga / hasu）
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS account TEXT;

-- RLS無効化（ログインなしでアクセス可能にする）
ALTER TABLE property_customers DISABLE ROW LEVEL SECURITY;

-- conversations ↔ property_customers 紐付け
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS property_customer_id UUID REFERENCES property_customers(id) ON DELETE SET NULL;

-- 申込以降マーク（申込・審査以降のトークを水色で区別）
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_post_apply BOOLEAN DEFAULT FALSE;

-- ai_reply_examples テーブル（LINE文案の自己学習用）
-- 実際に送信した返信を蓄積し、次回のAI生成プロンプトに注入する
CREATE TABLE IF NOT EXISTS ai_reply_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_state TEXT NOT NULL DEFAULT 'first_reply',
  customer_message TEXT NOT NULL,
  sent_reply TEXT NOT NULL,
  ai_draft TEXT,
  was_ai_used BOOLEAN DEFAULT FALSE,
  was_ai_modified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_reply_examples_state ON ai_reply_examples(conversation_state);
CREATE INDEX IF NOT EXISTS idx_ai_reply_examples_created_at ON ai_reply_examples(created_at DESC);

ALTER TABLE ai_reply_examples DISABLE ROW LEVEL SECURITY;

-- is_starred: スタッフが☆でマークした高品質な例（最優先でプロンプト注入）
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS is_starred BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_ai_reply_examples_starred ON ai_reply_examples(is_starred) WHERE is_starred = TRUE;

-- ai_reply_knowledge テーブル（LINE文案の深層学習用）
-- 例から自動抽出したパターン・口調・フレーズを蓄積し、生成プロンプトに注入する
CREATE TABLE IF NOT EXISTS ai_reply_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL CHECK (category IN ('pattern', 'style', 'phrase', 'principle')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  importance INTEGER DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  conversation_state TEXT,
  source_example_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_reply_knowledge_category ON ai_reply_knowledge(category);
CREATE INDEX IF NOT EXISTS idx_ai_reply_knowledge_importance ON ai_reply_knowledge(importance DESC);
CREATE INDEX IF NOT EXISTS idx_ai_reply_knowledge_state ON ai_reply_knowledge(conversation_state);

ALTER TABLE ai_reply_knowledge DISABLE ROW LEVEL SECURITY;

-- phrase_dictionary テーブル（LINE営業フレーズ辞書）
-- カテゴリ別にフレーズを管理。辞書ボタンや文案生成プロンプトに活用
CREATE TABLE IF NOT EXISTS phrase_dictionary (
  id BIGSERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  phrase TEXT NOT NULL,
  priority INTEGER DEFAULT 10,
  role TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_phrase_dictionary_category ON phrase_dictionary(category);
CREATE INDEX IF NOT EXISTS idx_phrase_dictionary_priority ON phrase_dictionary(priority DESC);

ALTER TABLE phrase_dictionary DISABLE ROW LEVEL SECURITY;

-- templates テーブル（LINEテンプレート管理）
CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL DEFAULT '全般',
  label TEXT NOT NULL,
  text TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  requires_image BOOLEAN NOT NULL DEFAULT false,
  structure JSONB DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);
CREATE INDEX IF NOT EXISTS idx_templates_sort_order ON templates(sort_order);

ALTER TABLE templates DISABLE ROW LEVEL SECURITY;

ALTER TABLE templates ADD COLUMN IF NOT EXISTS second_msg_type TEXT DEFAULT NULL;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS second_msg_delay INTEGER DEFAULT NULL;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS use_count INTEGER DEFAULT 0;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS win_rate NUMERIC DEFAULT 0;

-- estimates テーブル（見積書作成ツール）
CREATE TABLE IF NOT EXISTS estimates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account TEXT NOT NULL DEFAULT 'sumora',
  customer_name TEXT,
  property_name TEXT,
  move_in_date TEXT,
  rent INTEGER NOT NULL DEFAULT 0,
  management_fee INTEGER DEFAULT 0,
  shikikin_months NUMERIC DEFAULT 0,
  reikin_months NUMERIC DEFAULT 0,
  commission_rate NUMERIC DEFAULT 1.1,
  custom_commission INTEGER,
  guarantee INTEGER DEFAULT 0,
  insurance INTEGER DEFAULT 0,
  key_exchange INTEGER DEFAULT 0,
  cleaning INTEGER DEFAULT 0,
  other_items JSONB DEFAULT '[]',
  discount INTEGER DEFAULT 0,
  discount_note TEXT,
  supplementary_notes TEXT,
  items JSONB DEFAULT '[]',
  total INTEGER DEFAULT 0,
  line_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_estimates_account ON estimates(account);
CREATE INDEX IF NOT EXISTS idx_estimates_created_at ON estimates(created_at DESC);

ALTER TABLE estimates DISABLE ROW LEVEL SECURITY;

-- push_subscriptions テーブル（Web Push通知）
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE push_subscriptions DISABLE ROW LEVEL SECURITY;

-- 追加条件カラム（LINE追加メッセージを蓄積）
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS additional_conditions TEXT;

-- 元のLINEフォーマット全文を保存
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS raw_format_text TEXT;

-- 売上番長設定テーブル（グループIDなど）
CREATE TABLE IF NOT EXISTS hanbancyo_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE hanbancyo_settings DISABLE ROW LEVEL SECURITY;

-- 地名自動学習テーブル（AIが解決した地名→市区マッピングを蓄積）
CREATE TABLE IF NOT EXISTS region_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  ward TEXT NOT NULL,
  confidence INT DEFAULT 80,
  source TEXT DEFAULT 'ai',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE region_map DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_region_map_token ON region_map(token);

-- 駅自動学習テーブル（Web検索で解決した駅→路線+市区マッピングを蓄積）
CREATE TABLE IF NOT EXISTS station_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  ward TEXT,
  realpro_lines JSONB DEFAULT '[]',
  itandi_lines JSONB DEFAULT '[]',
  reins_line TEXT,
  source TEXT DEFAULT 'web_search',
  confidence INT DEFAULT 80,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE station_map DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_station_map_token ON station_map(token);

-- LINE顧客画像のStorageバケット（公開・5MB制限）
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('line-images', 'line-images', true, 5242880, ARRAY['image/jpeg','image/png','image/gif','image/webp'])
ON CONFLICT (id) DO NOTHING;

-- RLSポリシー: 公開読み取り + anon書き込み（LINEアカウントからのアップロード用）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='objects' AND policyname='line-images public read'
  ) THEN
    CREATE POLICY "line-images public read" ON storage.objects
      FOR SELECT USING (bucket_id = 'line-images');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='objects' AND policyname='line-images anon insert'
  ) THEN
    CREATE POLICY "line-images anon insert" ON storage.objects
      FOR INSERT WITH CHECK (bucket_id = 'line-images');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='objects' AND policyname='line-images anon delete'
  ) THEN
    CREATE POLICY "line-images anon delete" ON storage.objects
      FOR DELETE USING (bucket_id = 'line-images');
  END IF;
END $$;

-- 画像の保存期限（デフォルト30日。超過または会話内100枚超えで自動期限切れ）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_expires_at TIMESTAMPTZ;

-- 🔥あついお客さんフラグ（cronアナウンス用）
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_hot BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_conversations_is_hot ON conversations(is_hot) WHERE is_hot = TRUE;

-- ！要対応フラグ（LINE一覧での要対応バッジ表示用）
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_conversations_is_flagged ON conversations(is_flagged) WHERE is_flagged = TRUE;

-- 部屋の広さ（㎡以上・以下）
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS floor_area_min INTEGER;
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS floor_area_max INTEGER;

-- ペット飼育有無
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS pet BOOLEAN;

-- 物件送信カウント（返信なしで2回送ったら自動ダウングレード用）
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS property_send_count INTEGER DEFAULT 0;

-- 物件確認日時（お客さんが物件を確認した記録）
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS property_viewed_at TIMESTAMPTZ;

-- 🔥あついお客さん: 物件送信なしで「本日確認済み」を記録するカラム
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS hot_confirmed_at TIMESTAMPTZ;

-- messages.line_message_id UNIQUE制約（重複保存をDB側で根絶）
-- 既存の重複行を先に削除（created_at が古い方を残す）
DELETE FROM messages
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY line_message_id
      ORDER BY created_at ASC
    ) AS rn
    FROM messages
    WHERE line_message_id IS NOT NULL
  ) t
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_line_message_id_unique
  ON messages(line_message_id)
  WHERE line_message_id IS NOT NULL;

-- conversations.id に DEFAULT を付与（LINE webhookがid未指定でINSERTしても自動生成）
ALTER TABLE conversations ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;

-- 同一ユーザー×アカウントの重複会話を削除（updated_atが新しい方を残す）
DELETE FROM conversations
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY line_user_id, account
      ORDER BY updated_at DESC NULLS LAST
    ) AS rn
    FROM conversations
    WHERE line_user_id IS NOT NULL
  ) t
  WHERE rn > 1
);

-- conversations に UNIQUE(line_user_id, account) 制約を追加（race condition防止）
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_line_user_id_account_unique
  ON conversations(line_user_id, account)
  WHERE line_user_id IS NOT NULL;

-- AIXボタン設定テーブル（プロンプト・レスポンスルールをDB管理）
CREATE TABLE IF NOT EXISTS aix_settings (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE aix_settings DISABLE ROW LEVEL SECURITY;

-- AI要約カラム（お客さん一覧のAI要約機能用）
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS ai_summary TEXT;
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS ai_summary_at TIMESTAMPTZ;
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS ai_summary_json JSONB;

-- pgvector 拡張（類似例検索用）
CREATE EXTENSION IF NOT EXISTS vector;

-- ai_reply_examples: 埋め込みベクトルカラム（OpenAI text-embedding-3-small 1536次元）
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX IF NOT EXISTS idx_ai_reply_examples_embedding ON ai_reply_examples
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- タスク管理テーブル（物件確認・物件出し依頼）
CREATE TABLE IF NOT EXISTS line_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('property_check', 'property_send')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  customer_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
ALTER TABLE line_tasks DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_line_tasks_conversation_status ON line_tasks(conversation_id, status);
ALTER PUBLICATION supabase_realtime ADD TABLE line_tasks;
ALTER TABLE line_tasks DROP CONSTRAINT IF EXISTS line_tasks_status_check;
ALTER TABLE line_tasks ADD CONSTRAINT line_tasks_status_check CHECK (status IN ('pending', 'completed', 'cancelled'));

-- 返信ドラフト自動生成用
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_draft TEXT;

-- AI返信プロンプト管理テーブル（UIから確認・編集可能）
CREATE TABLE IF NOT EXISTS ai_prompts (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE ai_prompts DISABLE ROW LEVEL SECURITY;

-- ai_reply_examples: 4パターン返信の選択角度を記録（パターン学習用）
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS reply_angle TEXT;

-- ai_reply_examples: 差分自動学習の処理済みフラグ
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS diff_analyzed_at TIMESTAMPTZ;

-- ai_reply_knowledge: pgvector類似検索用embeddingカラム
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- ai_reply_knowledge: 使用回数トラッキング
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS used_count INTEGER DEFAULT 0;
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
CREATE OR REPLACE FUNCTION increment_knowledge_used_count(p_ids UUID[])
RETURNS void LANGUAGE sql AS $$
  UPDATE ai_reply_knowledge
  SET used_count = COALESCE(used_count, 0) + 1,
      last_used_at = NOW()
  WHERE id = ANY(p_ids);
$$;

-- テンプレート使用回数アトミックインクリメント（RMW競合を排除）
CREATE OR REPLACE FUNCTION increment_template_use_count(p_id UUID)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE templates
  SET use_count = COALESCE(use_count, 0) + 1,
      last_used_at = NOW()
  WHERE id = p_id;
$$;
CREATE INDEX IF NOT EXISTS ai_reply_knowledge_embedding_idx ON ai_reply_knowledge USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
-- created_at を戻り値に追加（generate-reply の鮮度スコアリングで使用）。
-- 戻り値の型変更は CREATE OR REPLACE では不可のため既存関数を先に DROP する
DROP FUNCTION IF EXISTS match_reply_knowledge(vector, integer, integer);
CREATE OR REPLACE FUNCTION match_reply_knowledge(query_embedding vector, match_count integer, min_importance integer DEFAULT 7)
RETURNS TABLE(id uuid, title text, content text, category text, conversation_state text, importance integer, similarity float, hypothesis_status text, created_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT ak.id, ak.title, ak.content, ak.category, ak.conversation_state, ak.importance,
    (1 - (ak.embedding <=> query_embedding))::float AS similarity,
    ak.hypothesis_status,
    ak.created_at
  FROM ai_reply_knowledge ak
  WHERE ak.embedding IS NOT NULL AND ak.importance >= min_importance
    AND COALESCE(ak.hypothesis_status, 'hypothesis') != 'rejected'
  ORDER BY ak.embedding <=> query_embedding LIMIT match_count
$$;

-- トリガーアクションルールテーブル（キーワード→AIXアクション マッピング）
CREATE TABLE IF NOT EXISTS trigger_action_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type TEXT NOT NULL,
  keyword TEXT NOT NULL,
  occurrence_count INTEGER DEFAULT 0,
  total_occurrence INTEGER DEFAULT 0,
  confidence FLOAT DEFAULT 0.0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(action_type, keyword)
);
CREATE INDEX IF NOT EXISTS idx_trigger_action_rules_action ON trigger_action_rules(action_type);
CREATE INDEX IF NOT EXISTS idx_trigger_action_rules_confidence ON trigger_action_rules(confidence DESC);
ALTER TABLE trigger_action_rules DISABLE ROW LEVEL SECURITY;

-- ── trigger_action_rules.category: 行タイプのDB側一元分類（2026-08-22）──
-- keyword 接頭辞による NOT LIKE 6連チェーン（brain-core / suggest-next-action /
-- aix-shadow-eval / learn-trigger-rules に分散・除外漏れバグあり）を廃止し、
-- BEFORE INSERT/UPDATE トリガーで category を自動分類する。書き込み側コードは無変更でよい。
-- 分類:
--   'chain_rule'         : AFTER:%（チェーンルール。learn-trigger-rules が upsert）
--   'stats'              : 統計5種（SUGGESTION_ACCEPT_RATE% / PREDICTION_ACCURACY% /
--                          SUBMODE_ACCEPT:% / SOURCE_ACCEPT_RATE% / TEMPLATE_HINT_ACCEPT_RATE:%）
--   'boundary_rule'      : BOUNDARY%（線引きルール行。brain-core L812 が読む）
--   'manual_rule_legacy' : MANUAL_RULE:%（旧形式の手動ルール残存行）
--   'keyword_rule'       : 上記以外（通常の n-gram キーワードルール・デフォルト）
ALTER TABLE trigger_action_rules ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'keyword_rule';

-- keyword 接頭辞 → category の単一真実源（トリガーとバックフィルの両方から呼ぶ）
CREATE OR REPLACE FUNCTION trigger_rule_category(p_keyword TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_keyword LIKE 'AFTER:%' THEN 'chain_rule'
    WHEN p_keyword LIKE 'SUGGESTION_ACCEPT_RATE%'
      OR p_keyword LIKE 'PREDICTION_ACCURACY%'
      OR p_keyword LIKE 'SUBMODE_ACCEPT:%'
      OR p_keyword LIKE 'SOURCE_ACCEPT_RATE%'
      OR p_keyword LIKE 'TEMPLATE_HINT_ACCEPT_RATE:%' THEN 'stats'
    WHEN p_keyword LIKE 'BOUNDARY%' THEN 'boundary_rule'
    WHEN p_keyword LIKE 'MANUAL_RULE:%' THEN 'manual_rule_legacy'
    ELSE 'keyword_rule'
  END;
$$;

-- BEFORE INSERT/UPDATE で category を keyword から自動導出（手動セット値も常に上書き＝分類の一元管理）
CREATE OR REPLACE FUNCTION set_trigger_action_rule_category()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.category := trigger_rule_category(NEW.keyword);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trigger_action_rules_set_category ON trigger_action_rules;
CREATE TRIGGER trg_trigger_action_rules_set_category
BEFORE INSERT OR UPDATE ON trigger_action_rules
FOR EACH ROW EXECUTE FUNCTION set_trigger_action_rule_category();

-- バックフィル（冪等: 分類がズレている行のみ更新）
UPDATE trigger_action_rules
SET category = trigger_rule_category(keyword)
WHERE category IS DISTINCT FROM trigger_rule_category(keyword);

CREATE INDEX IF NOT EXISTS idx_trigger_action_rules_category ON trigger_action_rules(category);
CREATE INDEX IF NOT EXISTS idx_trigger_action_rules_category_conf ON trigger_action_rules(category, confidence DESC);

-- テンプレートフレーズ学習テーブル（送信済みフレーズの蓄積・テンプレ画面でアナウンス用）
CREATE TABLE IF NOT EXISTS template_phrase_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type TEXT NOT NULL,
  conversation_status TEXT NOT NULL DEFAULT 'hearing',
  phrase TEXT NOT NULL,
  usage_count INTEGER DEFAULT 1,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(action_type, conversation_status, phrase)
);
CREATE INDEX IF NOT EXISTS idx_template_phrase_logs_action ON template_phrase_logs(action_type, conversation_status);
ALTER TABLE template_phrase_logs DISABLE ROW LEVEL SECURITY;

-- テンプレート選択ログ（どのテンプレを選んだか・AIおすすめと一致したか・修正したか）
CREATE TABLE IF NOT EXISTS template_selection_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  conversation_id TEXT,
  conversation_status TEXT,
  template_id UUID,
  template_category TEXT,
  recommended_rank INTEGER,
  was_recommended BOOLEAN DEFAULT false,
  was_adapted BOOLEAN DEFAULT false,
  was_modified_after_adapt BOOLEAN DEFAULT false,
  original_text TEXT,
  adapted_text TEXT,
  final_sent_text TEXT,
  aix_action_type TEXT
);
CREATE INDEX IF NOT EXISTS idx_tsl_conversation_id ON template_selection_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tsl_template_id ON template_selection_logs(template_id);
CREATE INDEX IF NOT EXISTS idx_tsl_created_at ON template_selection_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tsl_recommended_rank ON template_selection_logs(recommended_rank);
ALTER TABLE template_selection_logs ADD COLUMN IF NOT EXISTS modification_analyzed BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_tsl_not_analyzed ON template_selection_logs(modification_analyzed) WHERE modification_analyzed = false;
-- AIX→テンプレート全チェーン学習: どのバナー/フローからモーダルを開いたか（post_aix / apply_step1 / aix_flow / direct 等）
ALTER TABLE template_selection_logs ADD COLUMN IF NOT EXISTS open_context TEXT;
-- AIXピッカーのサブモード（check_pattern / app_sub_mode / send_mode / followup submode / pickup type）
ALTER TABLE template_selection_logs ADD COLUMN IF NOT EXISTS picker_mode TEXT;
CREATE INDEX IF NOT EXISTS idx_tsl_aix_chain ON template_selection_logs(aix_action_type, picker_mode) WHERE aix_action_type IS NOT NULL;
-- CHAIN-2: テンプレート連続送信のチェーン学習（同一AIXセッション内の何番目か・直前テンプレ・セッショングルーピングID）
ALTER TABLE template_selection_logs ADD COLUMN IF NOT EXISTS sequence_no INTEGER DEFAULT 1;
ALTER TABLE template_selection_logs ADD COLUMN IF NOT EXISTS prev_template_id UUID;
ALTER TABLE template_selection_logs ADD COLUMN IF NOT EXISTS aix_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tsl_aix_session ON template_selection_logs(aix_session_id) WHERE aix_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tsl_prev_template ON template_selection_logs(prev_template_id) WHERE prev_template_id IS NOT NULL;
-- テンプレ却下学習: brain の template_hint スナップショット（送信時に conversations.suggested_aix_meta がワイプされるため、select フェーズで記録して不一致学習に使う）
ALTER TABLE template_selection_logs ADD COLUMN IF NOT EXISTS brain_template_hint TEXT;
CREATE INDEX IF NOT EXISTS idx_tsl_brain_hint ON template_selection_logs(brain_template_hint) WHERE brain_template_hint IS NOT NULL;
ALTER TABLE template_selection_logs DISABLE ROW LEVEL SECURITY;

-- AI最適化後修正パターンの学習ルールテーブル（カテゴリ別・自動蓄積）
CREATE TABLE IF NOT EXISTS adaptation_improvement_rules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_triggered_at TIMESTAMPTZ DEFAULT now(),
  category TEXT NOT NULL,
  rule_text TEXT NOT NULL,
  confidence FLOAT DEFAULT 0.5,
  example_count INTEGER DEFAULT 1,
  is_active BOOLEAN DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_air_category ON adaptation_improvement_rules(category) WHERE is_active = true;
ALTER TABLE adaptation_improvement_rules DISABLE ROW LEVEL SECURITY;

-- AIXアクションパターン学習テーブル
-- 「このステータスでこのアクションが取られた」を蓄積して次アクション提案に活用
CREATE TABLE IF NOT EXISTS action_pattern_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_status TEXT NOT NULL,
  action_type TEXT NOT NULL,
  customer_msg_summary TEXT,
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_action_pattern_logs_status ON action_pattern_logs(conversation_status);
CREATE INDEX IF NOT EXISTS idx_action_pattern_logs_action ON action_pattern_logs(action_type);
CREATE INDEX IF NOT EXISTS idx_action_pattern_logs_created_at ON action_pattern_logs(created_at DESC);
ALTER TABLE action_pattern_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE action_pattern_logs ADD COLUMN IF NOT EXISTS previous_action_type TEXT;

-- line_tasks: estimate_sheet を許可
ALTER TABLE line_tasks DROP CONSTRAINT IF EXISTS line_tasks_task_type_check;
ALTER TABLE line_tasks ADD CONSTRAINT line_tasks_task_type_check
  CHECK (task_type IN ('property_check', 'property_send', 'estimate_sheet'));

-- line_tasks: 同一会話×タスクタイプのペンディングは1件のみ（重複🔍確認中防止）
DELETE FROM line_tasks
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY conversation_id, task_type
             ORDER BY created_at ASC
           ) AS rn
    FROM line_tasks
    WHERE status = 'pending'
  ) sub
  WHERE rn > 1
);
CREATE UNIQUE INDEX IF NOT EXISTS line_tasks_conv_type_pending_unique
ON line_tasks (conversation_id, task_type)
WHERE status = 'pending';

-- aix_usage_logs: AIXフロー使用ログ（どのAIX+テンプレートが送信されたか）
CREATE TABLE IF NOT EXISTS aix_usage_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id text NOT NULL,
  aix_type text NOT NULL,
  template_name text,
  template_category text,
  conversation_status text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aix_usage_logs_conversation_id ON aix_usage_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_aix_usage_logs_created_at ON aix_usage_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aix_usage_logs_aix_type ON aix_usage_logs(aix_type);
CREATE INDEX IF NOT EXISTS idx_aix_usage_logs_conv_created ON aix_usage_logs(conversation_id, created_at DESC);

-- draft_pending_at ADD COLUMN（後続のインデックスより前に必要）
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS draft_pending_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS draft_attempted_at TIMESTAMPTZ;

-- パフォーマンス強化: 毎分Cronが叩くカラムのインデックス
CREATE INDEX IF NOT EXISTS idx_conversations_draft_pending_at ON conversations(draft_pending_at) WHERE draft_pending_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_draft_attempted_at ON conversations(draft_attempted_at) WHERE draft_attempted_at IS NOT NULL;

-- ai_reply_knowledge の ilike '%差分学習%' / '%修正対比%' 全件スキャン削減
CREATE INDEX IF NOT EXISTS idx_ai_reply_knowledge_title_pattern ON ai_reply_knowledge(title text_pattern_ops);
ALTER TABLE aix_usage_logs DISABLE ROW LEVEL SECURITY;

-- viewings テーブル（内覧予定管理・アナウンス自動化用）
CREATE TABLE IF NOT EXISTS viewings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL,
  customer_name TEXT,
  viewing_date DATE NOT NULL,
  viewing_time TIME,
  status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'done', 'cancelled')),
  pre_announce_sent BOOLEAN DEFAULT FALSE,
  post_announce_sent BOOLEAN DEFAULT FALSE,
  cheer_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE viewings ADD COLUMN IF NOT EXISTS cheer_sent BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_viewings_date ON viewings(viewing_date);
CREATE INDEX IF NOT EXISTS idx_viewings_conversation ON viewings(conversation_id);
ALTER TABLE viewings DISABLE ROW LEVEL SECURITY;

-- match_reply_examples: reply_angleを返り値に追加（選ばれた実例のブースト用）
-- 戻り値型変更のためDROP→CREATEが必要
DROP FUNCTION IF EXISTS match_reply_examples(vector, int, text[]);
CREATE OR REPLACE FUNCTION match_reply_examples(query_embedding vector(1536), match_count int, filter_states text[])
RETURNS TABLE (id uuid, customer_message text, sent_reply text, conversation_state text, is_starred boolean, reply_angle text, similarity float)
LANGUAGE sql STABLE AS $func$
  SELECT ae.id, ae.customer_message, ae.sent_reply, ae.conversation_state, ae.is_starred, ae.reply_angle, (1 - (ae.embedding <=> query_embedding))::float AS similarity
  FROM ai_reply_examples ae
  WHERE ae.conversation_state = ANY(filter_states)
    AND ae.embedding IS NOT NULL
    AND ae.entry_source = 'line_reply'
  ORDER BY ae.embedding <=> query_embedding
  LIMIT match_count
$func$;

-- ai_reply_examples: 会話紐付け（返信→成果の帰属追跡・ループ学習用）
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ai_reply_examples_conv_id ON ai_reply_examples(conversation_id);

-- ai_reply_examples: 実際の送信時刻（G-04: page.tsx から sentAt を受け取り保存）
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

-- 路線別駅順序テーブル（隣駅展開・広げて検索用）
CREATE TABLE IF NOT EXISTS line_stations (
  line_name TEXT NOT NULL,
  station_name TEXT NOT NULL,
  order_idx INT NOT NULL,
  PRIMARY KEY (line_name, station_name)
);
CREATE INDEX IF NOT EXISTS idx_line_stations_line ON line_stations(line_name);
CREATE INDEX IF NOT EXISTS idx_line_stations_station ON line_stations(station_name);
ALTER TABLE line_stations DISABLE ROW LEVEL SECURITY;

-- pg_trgm 拡張（表記ゆれ吸収・類似検索）
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_station_map_token_trgm ON station_map USING gin (token gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_region_map_token_trgm ON region_map USING gin (token gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_line_stations_station_trgm ON line_stations USING gin (station_name gin_trgm_ops);

CREATE OR REPLACE FUNCTION find_similar_station(query_text TEXT, threshold FLOAT DEFAULT 0.35)
RETURNS TABLE(token TEXT, ward TEXT, realpro_lines JSONB, itandi_lines JSONB, reins_line TEXT, similarity_score FLOAT)
LANGUAGE sql STABLE AS $$
  SELECT token, ward, realpro_lines, itandi_lines, reins_line,
         similarity(token, query_text) AS similarity_score
  FROM station_map
  WHERE similarity(token, query_text) >= threshold
  ORDER BY similarity_score DESC LIMIT 3;
$$;

CREATE OR REPLACE FUNCTION find_similar_region(query_text TEXT, threshold FLOAT DEFAULT 0.35)
RETURNS TABLE(token TEXT, ward TEXT, similarity_score FLOAT)
LANGUAGE sql STABLE AS $$
  SELECT token, ward, similarity(token, query_text) AS similarity_score
  FROM region_map
  WHERE similarity(token, query_text) >= threshold
  ORDER BY similarity_score DESC LIMIT 3;
$$;

CREATE OR REPLACE FUNCTION find_similar_line_station(query_text TEXT, threshold FLOAT DEFAULT 0.35)
RETURNS TABLE(station_name TEXT, line_name TEXT, token TEXT, ward TEXT, realpro_lines JSONB, itandi_lines JSONB, reins_line TEXT, similarity_score FLOAT)
LANGUAGE sql STABLE AS $$
  SELECT ls.station_name, ls.line_name, sm.token, sm.ward,
         sm.realpro_lines, sm.itandi_lines, sm.reins_line,
         similarity(ls.station_name, query_text) AS similarity_score
  FROM line_stations ls
  LEFT JOIN station_map sm ON sm.token = ls.station_name
  WHERE similarity(ls.station_name, query_text) >= threshold
  ORDER BY similarity_score DESC LIMIT 5;
$$;

-- ai_reply_examples: 自動品質チェック結果フラグ
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS quality_auto_ok BOOLEAN;

-- conversations: 自動送信フラグ（Phase3 auto-send準備用）
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS auto_send_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS auto_sent_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS auto_sent_draft TEXT;

-- AI テンプレート候補テーブル（AIXボタン送信後に候補として蓄積し、採用でtemplatesに昇格）
CREATE TABLE IF NOT EXISTS ai_template_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type TEXT NOT NULL,
  category TEXT NOT NULL,
  suggested_title TEXT NOT NULL,
  template_text TEXT NOT NULL,
  conversation_id TEXT,
  is_adopted BOOLEAN DEFAULT FALSE,
  is_dismissed BOOLEAN DEFAULT FALSE,
  adopted_template_id UUID REFERENCES templates(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_template_candidates_action ON ai_template_candidates(action_type);
CREATE INDEX IF NOT EXISTS idx_ai_template_candidates_pending ON ai_template_candidates(is_adopted, is_dismissed);
ALTER TABLE ai_template_candidates DISABLE ROW LEVEL SECURITY;

-- AIX編集検知カラム（ユーザーがAI生成文を編集して送信した場合にaix_editとして記録）
ALTER TABLE ai_template_candidates ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE ai_template_candidates ADD COLUMN IF NOT EXISTS original_text TEXT NULL;

-- P1: テンプレ候補の根拠・証拠カウント・却下理由（候補品質改善）
-- reason: なぜこの候補が出たか / evidence_count: 同じ編集パターンの観測回数（dedup時にカウントアップ）
-- dismissed_reason: スタッフが却下した理由（P5理由チップ → corpus2skill週次学習の材料）
ALTER TABLE ai_template_candidates ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE ai_template_candidates ADD COLUMN IF NOT EXISTS evidence_count INTEGER DEFAULT 1;
ALTER TABLE ai_template_candidates ADD COLUMN IF NOT EXISTS dismissed_reason TEXT;

-- LX-4: 予測アクション追跡カラム
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS suggested_action TEXT DEFAULT NULL;

-- P1: AIX経由テンプレのuse_count計測（どのテンプレIDが使われたか記録）
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS template_id UUID DEFAULT NULL;

-- P4: AIX送信メッセージの厳密特定（LINE message id + 送信時刻）
-- auto-template-candidates が ±10分ヒューリスティックではなく sent_at ベースの厳密マッチを行える
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS line_message_id TEXT DEFAULT NULL;
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE action_pattern_logs ADD COLUMN IF NOT EXISTS predicted_action TEXT DEFAULT NULL;

-- PA-1: previous_action_type の確実な記録（in-memory refのリロード消失対策）
-- aix_usage_logs にも前アクションを持たせ、action_pattern_logs は conversation_id でDB復元・バックフィル可能にする
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS previous_action_type TEXT DEFAULT NULL;
ALTER TABLE action_pattern_logs ADD COLUMN IF NOT EXISTS conversation_id TEXT DEFAULT NULL;

-- 中5: 提案経路の記録（suggest-next-action レスポンスの source: keyword_hardcode / trigger_rule / chain_rule / ai_fallback 等）
-- update-action-confidence cron が action×source 粒度で SOURCE_ACCEPT_RATE:{action}:{source} を集計するのに使う
ALTER TABLE action_pattern_logs ADD COLUMN IF NOT EXISTS suggestion_source TEXT DEFAULT NULL;

-- 案5: AIX提案バナー却下理由の即時キャプチャ（✕タップ→3択チップ）
-- 'timing_early'（タイミング早い）| 'wrong_action'（アクション違う）| 'already_done'（もう対応済み）
-- suggestion_dismissed のログにのみ入る。学習側が「なぜ却下されたか」を区別できるようにする
ALTER TABLE action_pattern_logs ADD COLUMN IF NOT EXISTS dismissed_reason TEXT DEFAULT NULL;

-- SUB-1: AIXピッカー選択のサブパターンを記録（学習精度・成果集計の粒度向上）
-- check_pattern: property_check_result のサブパターン（available/unavailable/alternative/vacate_date等）
-- app_sub_mode: application_push のサブモード（push/confirm/docs_request/format）
-- send_mode: property_send のモード（normal/new_arrival/widen/alternative）
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS check_pattern TEXT DEFAULT NULL;
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS app_sub_mode TEXT DEFAULT NULL;
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS send_mode TEXT DEFAULT NULL;

-- 失注分析済みフラグ（auto-analyze-losers の毎日再課金防止）
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS loss_analyzed_at TIMESTAMPTZ;

-- 成功パターン学習の重複実行ガード（notify-viewing の after() 二重起動・リトライ防止）
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS success_pattern_at TIMESTAMPTZ;

-- 下書き生成の試行時刻（generate-pending-drafts のorphaned救済リトライ制御。
-- インメモリMapはVercelサーバーレスでインスタンス間共有不可のためDB側フラグで10分スキップを実現）
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS draft_attempted_at TIMESTAMPTZ;

-- P5: 成果アトリビューション週次集計（どのAIXアクション・テンプレが内覧/申込/成約に繋がったか）
-- calc-aix-attribution cron（毎週日曜 JST 04:00）が過去7日分を集計して保存
CREATE TABLE IF NOT EXISTS aix_action_attribution (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  action_type TEXT NOT NULL,
  template_id UUID,
  template_label TEXT,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  usage_count INTEGER DEFAULT 0,
  unique_conversations INTEGER DEFAULT 0,
  viewing_reached INTEGER DEFAULT 0,
  application_reached INTEGER DEFAULT 0,
  closed_won INTEGER DEFAULT 0,
  viewing_rate NUMERIC(5,3),
  application_rate NUMERIC(5,3),
  win_rate NUMERIC(5,3),
  calculated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_aix_action_attribution_unique
  ON aix_action_attribution (action_type, COALESCE(template_id::text, 'none'), period_start);
CREATE INDEX IF NOT EXISTS idx_aix_action_attribution_period ON aix_action_attribution(period_start DESC);
ALTER TABLE aix_action_attribution DISABLE ROW LEVEL SECURITY;

-- ⑥ embedding_cache テーブル（OpenAI embedding の永続キャッシュ・再起動後も再利用）
CREATE TABLE IF NOT EXISTS embedding_cache (
  text_key TEXT PRIMARY KEY,
  embedding JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE embedding_cache DISABLE ROW LEVEL SECURITY;

-- ai_reply_knowledge: 仮説検証ループ（RLHF学習）
-- hypothesis → 確認中 / confirmed → 5回以上・正解率70%以上 / rejected → 5回以上・外れ率70%以上
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS hypothesis_status TEXT DEFAULT 'hypothesis';
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS apply_count INT DEFAULT 0;
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS correct_count INT DEFAULT 0;
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS wrong_count INT DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_ai_reply_knowledge_hypothesis ON ai_reply_knowledge(hypothesis_status);

-- knowledge_apply_log: どのルールをどの会話で適用したか追跡（フィードバックループの橋渡し）
CREATE TABLE IF NOT EXISTS knowledge_apply_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_id UUID REFERENCES ai_reply_knowledge(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  example_id UUID REFERENCES ai_reply_examples(id) ON DELETE SET NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW(),
  result TEXT DEFAULT 'pending' CHECK (result IN ('pending', 'correct', 'wrong'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_apply_log_knowledge ON knowledge_apply_log(knowledge_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_apply_log_conversation ON knowledge_apply_log(conversation_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_apply_log_conv_pending ON knowledge_apply_log(conversation_id, result) WHERE result = 'pending';
ALTER TABLE knowledge_apply_log DISABLE ROW LEVEL SECURITY;
-- C05: generate-reply と aix/action が同一 conversation_id に書くため、どちら由来かを区別するカラムを追加
--      confirm_knowledge_feedback を source でスコープすることで誤フィードバック混入を防ぐ
ALTER TABLE knowledge_apply_log ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'generate_reply';
CREATE INDEX IF NOT EXISTS idx_knowledge_apply_log_source ON knowledge_apply_log(source);

-- confirm_knowledge_feedback: 正解/外れを記録し自動昇格/降格する
-- C05: p_source (NULL=全ソース対象 / 'generate_reply' | 'aix_action' = 絞り込み) を追加
-- RLHF-002: 直近24時間のpendingのみ対象（会話全体の巻き込み反転を防止しつつ、翌日返信の学習漏れを防ぐ / 改善②で1時間→24時間に拡大）
CREATE OR REPLACE FUNCTION confirm_knowledge_feedback(
  p_conversation_id TEXT,
  p_result TEXT,
  p_source TEXT DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_knowledge_ids UUID[];
BEGIN
  SELECT ARRAY_AGG(DISTINCT knowledge_id) INTO v_knowledge_ids
  FROM knowledge_apply_log
  WHERE conversation_id = p_conversation_id AND result = 'pending'
    AND (p_source IS NULL OR source = p_source)
    AND applied_at > NOW() - INTERVAL '7 days';
  IF v_knowledge_ids IS NULL OR ARRAY_LENGTH(v_knowledge_ids, 1) = 0 THEN RETURN; END IF;
  UPDATE knowledge_apply_log
  SET result = p_result
  WHERE conversation_id = p_conversation_id AND result = 'pending'
    AND (p_source IS NULL OR source = p_source)
    AND applied_at > NOW() - INTERVAL '7 days';
  UPDATE ai_reply_knowledge
  SET
    apply_count   = COALESCE(apply_count, 0) + 1,
    correct_count = CASE WHEN p_result = 'correct' THEN COALESCE(correct_count, 0) + 1 ELSE COALESCE(correct_count, 0) END,
    wrong_count   = CASE WHEN p_result = 'wrong'   THEN COALESCE(wrong_count, 0)   + 1 ELSE COALESCE(wrong_count, 0) END,
    last_applied_at = NOW()
  WHERE id = ANY(v_knowledge_ids);
  UPDATE ai_reply_knowledge
  SET hypothesis_status = CASE
    WHEN apply_count >= 5 AND correct_count::float / NULLIF(apply_count::float, 0) >= 0.7 THEN 'confirmed'
    WHEN apply_count >= 5 AND wrong_count::float   / NULLIF(apply_count::float, 0) >= 0.7 THEN 'rejected'
    ELSE hypothesis_status
  END
  WHERE id = ANY(v_knowledge_ids) AND apply_count >= 5;
END;
$$;

-- templates: テンプレート採用率トラッキング（RLHFループ）
-- おすすめとして提示された回数・実際に選ばれた回数を記録し採用率を算出する
ALTER TABLE templates ADD COLUMN IF NOT EXISTS recommend_shown_count INT DEFAULT 0;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS recommend_picked_count INT DEFAULT 0;

-- increment_template_recommend_shown: おすすめ提示時に shown_count を一括 +1
CREATE OR REPLACE FUNCTION increment_template_recommend_shown(p_ids UUID[])
RETURNS void LANGUAGE sql AS $$
  UPDATE templates SET recommend_shown_count = COALESCE(recommend_shown_count,0)+1 WHERE id = ANY(p_ids)
$$;

-- increment_template_recommend_picked: おすすめから選択時に picked_count を +1
CREATE OR REPLACE FUNCTION increment_template_recommend_picked(p_id UUID)
RETURNS void LANGUAGE sql AS $$
  UPDATE templates SET recommend_picked_count = COALESCE(recommend_picked_count,0)+1 WHERE id = p_id
$$;

-- next_action_logs: 次のアクション予測 vs 実際の行動を記録し差分学習するためのテーブル
CREATE TABLE IF NOT EXISTS next_action_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES property_customers(id) ON DELETE CASCADE,
  conversation_id TEXT,
  predicted_action TEXT NOT NULL,
  predicted_at TIMESTAMPTZ DEFAULT NOW(),
  validated BOOLEAN DEFAULT FALSE,
  actual_aix_type TEXT,
  actual_message_preview TEXT,
  was_accurate BOOLEAN,
  gap_analysis TEXT,
  validated_at TIMESTAMPTZ
);
ALTER TABLE next_action_logs DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_next_action_logs_customer ON next_action_logs(customer_id, validated, predicted_at DESC);

-- ai_reply_examples: 物件ピックアップした の構成パーツ別JSON（コンポーネント学習ループ用）
-- intro / pickup / vacating / invite / calendar / closing の各パーツを保存し差分を構成単位で追跡
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS ai_components JSONB;

-- ai_reply_examples: テンプレートIDの紐付け（テンプレート→送信→成果の学習ループ用）
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS template_id UUID DEFAULT NULL;
-- aix_usage_logs: サブパターン詳細列（どのピッカー選択をしたか）
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS check_pattern TEXT DEFAULT NULL;
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS app_sub_mode TEXT DEFAULT NULL;
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS send_mode TEXT DEFAULT NULL;

-- ai_prompt_rules: オペレーター設定ルール（動的プロンプト注入・コード外管理）
-- action_type=NULL → 全アクション・generate-reply にも適用（グローバルルール）
-- condition_key=NULL → 常時適用（条件なし）
-- 冪等性: rule_key UNIQUE + ON CONFLICT DO NOTHING で migration 再実行しても重複しない
CREATE TABLE IF NOT EXISTS ai_prompt_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key TEXT UNIQUE NOT NULL,
  action_type TEXT,
  condition_key TEXT,
  condition_value TEXT,
  rule_text TEXT NOT NULL,
  reason TEXT,
  priority INT DEFAULT 5,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_prompt_rules_action ON ai_prompt_rules(action_type);
CREATE INDEX IF NOT EXISTS idx_ai_prompt_rules_active ON ai_prompt_rules(is_active) WHERE is_active = TRUE;
ALTER TABLE ai_prompt_rules DISABLE ROW LEVEL SECURITY;

-- 初期ルール（ON CONFLICT DO NOTHING で冪等・重複挿入しない）
INSERT INTO ai_prompt_rules (rule_key, action_type, condition_key, condition_value, rule_text, reason, priority) VALUES

('APP-EST-001', 'application_push', 'has_estimate', 'true',
 '物件アピール（①）では「費用」「見積書」「初期費用」への言及は絶対禁止。お客様はすでに見積書を受け取っており、①で再言及するのは信頼低下の原因。②CTAのみ「初期費用面もお気に召されましたら」と一言触れる。',
 '申込誘導で見積書を再言及するバグをユーザーが報告（2026-07-09）。hasEst=true時は①での費用言及を完全禁止にする最重要ルール。',
 10),

('APP-DOCS-001', 'application_push', 'app_sub_mode', 'docs_request',
 '書類依頼リストに「保険証」を絶対に含めないこと（申込時不要）。本人確認書類は「運転免許証」または「マイナンバーカード」の2種のみ明記。「等」を付けて曖昧にしない。',
 '保険証は申込時不要。誤って依頼するとお客様が混乱し信頼を失う。2種類のみ明記が必須。',
 9),

('APP-CONF-001', 'application_push', 'app_sub_mode', 'confirm',
 '申込確認メッセージは2行のみ厳守。①「かしこまりました！！」②「[物件名]お申込みさせて頂きます😊！！」。書類案内・費用・審査説明は一切追加しない。',
 'confirmでは短い確認文が自然。長い返信はお客様を混乱させ次工程への信頼を損なう。',
 8),

('VIEW-MULTI-001', 'viewing_invite', NULL, NULL,
 'カレンダーに複数の案内可能日時がある場合は、全日程を漏れなく提示すること。1日だけ案内して他の日程を省略することは絶対禁止。',
 '1日しか提示しないとお客様の都合が合わず内覧キャンセルになりやすい。全日程提示が成約率に直結する。',
 9),

('PROP-VCC-001', 'property_recommendation', 'vacancy_status', 'scheduled',
 '退去予定物件（現在入居中）を紹介する際は、内覧がまだできないことを必ず明記すること。「現在入居中のため内覧はまだできないお部屋ですが、お申込みで確保可能です」の旨を含める。',
 '内覧できないと知らずに来店するトラブルを防ぐ。透明性がお客様の信頼に繋がる。',
 9),

('GLOB-PREAMBLE-001', NULL, NULL, NULL,
 '「お伝えしたいことがあります」「一点お知らせ」「実は〜なのですが」などの前振り表現は使わない。本題から直接入ること。',
 'LINEでは前振りは回りくどく不自然。直接本題に入ることがスモラのトーンに合う。',
 7),

('GLOB-PUNCT-001', NULL, NULL, NULL,
 '文末を「？」で終わることは禁止。必ず「！！」で締めること。例: 「いかがでしょうか！！」「ご確認いただけますでしょうか！！」',
 'スモラのブランドトーンは「！！」で統一。「？」は消極的な印象を与え成約率が下がる。',
 7),

('GLOB-TIKTOK-001', NULL, NULL, NULL,
 'TikTok・YouTube・SNS・インターネット上の情報への言及は絶対禁止。不動産仲介のプロとして直接的な情報のみを提供する。',
 'SNS言及はプロフェッショナリズムを損なう。スモラはSNS経由の問い合わせもあるため混乱を招く。',
 8)

ON CONFLICT (rule_key) DO NOTHING;

-- ① conversations.draft_pending_at ADD COLUMN 漏れ修正
-- （インデックスは613行目に先行して追加されていたが ADD COLUMN が抜けていた）
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS draft_pending_at TIMESTAMPTZ;

-- ② LINE ブロック/フォロー解除ステータス管理
-- line_status: 'active'（通常）| 'blocked'（ブロック済み）| 'unfollowed'（フォロー解除）
-- unfollow イベント受信時に自動更新 → フォロー解除済みお客様への送信を防止
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS line_status TEXT DEFAULT 'active';
ALTER TABLE line_contacts ADD COLUMN IF NOT EXISTS line_status TEXT DEFAULT 'active';
CREATE INDEX IF NOT EXISTS idx_conversations_line_status ON conversations(line_status) WHERE line_status != 'active';
CREATE INDEX IF NOT EXISTS idx_line_contacts_line_status ON line_contacts(line_status) WHERE line_status != 'active';

-- ③ cron実行ログ（14個のcronが動いているが実行記録が全くない問題を解決）
-- cron_name: 'analyze-diffs' | 'calc-aix-attribution' | 'morning-report' 等
-- ok=false + error_message でサイレント失敗を検知可能
CREATE TABLE IF NOT EXISTS cron_run_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_name TEXT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  ok BOOLEAN,
  result_json JSONB,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_cron_run_logs_name_at ON cron_run_logs(cron_name, started_at DESC);
ALTER TABLE cron_run_logs DISABLE ROW LEVEL SECURITY;

-- ④ AIX生成文案ログ（AIXが生成した文案を保存しAI改善ループを完成させる）
-- generated_text: AIXが生成したが実際に送られたかどうかは line_message_id で照合
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS generated_text TEXT;

-- ⑤ ai_prompt_rules.updated_at（手動編集時刻を追跡）
ALTER TABLE ai_prompt_rules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- ⑦ was_edited: AIXが生成した文をスタッフが編集して送ったか（断線④修正）
-- AixModal側でaiDraftとpreviewを比較して算出し、log-aix-usage経由で記録される
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS was_edited BOOLEAN;

-- ⑥ match_reply_knowledge を hypothesis_status ADD COLUMN の後に再定義
--    （line 479 での定義は hypothesis_status が存在しない新規環境で失敗するため、
--      hypothesis_status ADD COLUMN（line 802）の後にも再実行する）
--    戻り値型の変更に備え DROP → CREATE で再定義（created_at は鮮度スコアリング用）
DROP FUNCTION IF EXISTS match_reply_knowledge(vector, integer, integer);
CREATE OR REPLACE FUNCTION match_reply_knowledge(query_embedding vector, match_count integer, min_importance integer DEFAULT 7)
RETURNS TABLE(id uuid, title text, content text, category text, conversation_state text, importance integer, similarity float, hypothesis_status text, created_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT ak.id, ak.title, ak.content, ak.category, ak.conversation_state, ak.importance,
    (1 - (ak.embedding <=> query_embedding))::float AS similarity,
    ak.hypothesis_status,
    ak.created_at
  FROM ai_reply_knowledge ak
  WHERE ak.embedding IS NOT NULL AND ak.importance >= min_importance
    AND COALESCE(ak.hypothesis_status, 'hypothesis') != 'rejected'
  ORDER BY ak.embedding <=> query_embedding LIMIT match_count
$$;

-- 自動返信化準備スコアの時系列スナップショット（週次 upsert で最新1件になるのを防ぐ）
CREATE TABLE IF NOT EXISTS aix_readiness_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date date NOT NULL,
  aix_type text NOT NULL,
  acceptance_rate numeric,
  edit_rate numeric,
  ready boolean NOT NULL DEFAULT false,
  reason text,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS aix_readiness_snapshots_date_type_idx
  ON aix_readiness_snapshots (report_date, aix_type);

-- AIXフロー誘導ガイドのバージョン履歴（毎日 upsert で上書きされる aix_flow_guide の変遷を保存）
CREATE TABLE IF NOT EXISTS ai_prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_key text NOT NULL,
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_prompt_versions_key_idx ON ai_prompt_versions (prompt_key, created_at DESC);

-- 将来1: シャドーモード評価ログ（aix-shadow-eval cron が毎日記録）
-- 「もし自動送信だったら何を提案したか」vs「スタッフが実際に押したAIX」の一致率を計測する
-- usage_log_id: 評価対象の aix_usage_logs.id（UNIQUE部分インデックスで再実行時の重複評価を防止）
-- source: suggest-next-action がどのルートで予測したか（chain_rule / keyword_hardcode / trigger_rule / status_rule / followup_rule / ai_fallback）
CREATE TABLE IF NOT EXISTS aix_shadow_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usage_log_id UUID,
  conversation_id TEXT NOT NULL,
  predicted_aix_type TEXT,
  actual_aix_type TEXT NOT NULL,
  matched BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT,
  predicted_at TIMESTAMPTZ,
  evaluated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_aix_shadow_logs_usage_log
  ON aix_shadow_logs(usage_log_id) WHERE usage_log_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aix_shadow_logs_evaluated_at ON aix_shadow_logs(evaluated_at DESC);
ALTER TABLE aix_shadow_logs DISABLE ROW LEVEL SECURITY;

-- 将来3: 顧客反応評価（AIX送信後24時間以内に顧客返信があったか / eval-customer-reaction cron が毎日更新）
-- NULL=未評価 / TRUE=24h以内に顧客返信あり / FALSE=返信なし
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS customer_reacted BOOLEAN;

-- 中1: winning_pattern 成果検証ログ（customer-summary が予測を記録し、
-- eval-winning-pattern cron（毎週月曜 JST 9:00）が conversations.status と突合して答え合わせする）
CREATE TABLE IF NOT EXISTS winning_pattern_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL,
  customer_id text,
  predicted_pattern text NOT NULL,
  actual_outcome text,
  was_correct boolean,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_winning_pattern_logs_pending
  ON winning_pattern_logs(created_at DESC) WHERE actual_outcome IS NULL;
CREATE INDEX IF NOT EXISTS idx_winning_pattern_logs_conversation
  ON winning_pattern_logs(conversation_id);
ALTER TABLE winning_pattern_logs DISABLE ROW LEVEL SECURITY;

-- 中3: 負のフィードバック用RPC — AI文案に注入されたのにスタッフが消したフレーズ/パターンの importance を減衰
-- （ai_reply_knowledge に priority カラムは存在しないため importance を減衰対象とする。最小1で下げ止め）
CREATE OR REPLACE FUNCTION decay_knowledge_importance(p_ids UUID[])
RETURNS void LANGUAGE sql AS $$
  UPDATE ai_reply_knowledge
  SET importance = GREATEST(1, COALESCE(importance, 5) - 1)
  WHERE id = ANY(p_ids);
$$;

-- 高5: 成約パターン検索の人間性中心化
-- 成約事例の人間性プロファイルを保存（pgvectorの類似検索をproperty条件ではなく人間性で行うため）
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS personality_tags TEXT;

-- winning_pattern_logs: 予測時点の顧客の人間性プロファイルを保存
-- （customer-summary が INSERT 時に付与。was_correct=true になった行を「人間性が似た顧客で当たった一手」として検索する）
ALTER TABLE winning_pattern_logs ADD COLUMN IF NOT EXISTS personality_profile TEXT;

-- winning_patterns: 成約・失注会話から抽出した構造化パターンテーブル（RAG検索対応）
CREATE TABLE IF NOT EXISTS winning_patterns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  situation             text,
  pattern               text NOT NULL,
  closing_action        text,
  human_type_label      text,
  outcome_type          text NOT NULL DEFAULT 'closed_won',
  notes                 text,
  win_rate              numeric,
  source_conversation_id text,
  embedding             vector(1536),
  importance            integer DEFAULT 8,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS winning_patterns_embedding_idx
  ON winning_patterns USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- 成約分析（analyze-closed-conversation）: 申込/成約確定時に Opus 4.8 が
-- 会話全体から抽出した「確定人間性プロファイル」を顧客に保存する
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS personality_profile TEXT;

-- H4: シーン×テンプレの事前分布学習（calc-template-scene-stats cron が週1更新）
-- { "hearing": 12, "proposing": 5 } 形式で conversation_status 別の送信実績を保持し、
-- TemplateModal が現在のステータスに合わせて上位テンプレを昇格表示する
ALTER TABLE templates ADD COLUMN IF NOT EXISTS status_pick_stats JSONB DEFAULT '{}';

-- P4: AIX機能改善提案テーブル（corpus2skill 週次Opusが「新AIX/新ピッカー/新サブモード」提案を保存）
-- TemplateModal の「💡 AIX改善案」タブで採用/却下を管理する
CREATE TABLE IF NOT EXISTS aix_feature_suggestions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  suggestion_type TEXT NOT NULL, -- 'new_aix' | 'new_picker' | 'new_sub_mode'
  action_type TEXT,
  suggested_title TEXT NOT NULL,
  description TEXT,
  reason TEXT,
  evidence_count INTEGER DEFAULT 1,
  example_diffs JSONB,
  status TEXT DEFAULT 'pending', -- 'pending' | 'adopted' | 'dismissed'
  dismissed_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aix_feature_suggestions_pending
  ON aix_feature_suggestions(created_at DESC) WHERE status = 'pending';
ALTER TABLE aix_feature_suggestions DISABLE ROW LEVEL SECURITY;

-- AI盲点フィードバック（corpus2skill 週次Opusが「分からない部分・憶測・発見した抜け」を質問として生成 →
-- TemplateModal「❓ AI質問」タブで竹内さんが回答 → /api/ai-feedback がSonnetで知識化して
-- trigger_action_rules（trigger_keywords を通常n-gramルールとして高confidence保存）/
-- ai_prompts（feedback_rule_{id}）+ ai_prompt_rules（FEEDBACK-{id}-{n}）に保存する）
CREATE TABLE IF NOT EXISTS ai_feedback_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  question TEXT NOT NULL,
  speculation TEXT,
  category TEXT,  -- 'knowledge_gap'（corpus2skill盲点発見: AIが誤った事実を述べた） | 'prompt_ambiguity'（使用条件の誤解） | 'new_flow' | 'missing_keyword' | 'weak_scene' | 'new_aix_needed' | 'phrase_contamination'（analyze-diffs回帰センチネル起票） | 'general'
  evidence TEXT,
  confidence TEXT DEFAULT 'medium',  -- 'high' | 'medium' | 'low'
  user_answer TEXT,
  status TEXT DEFAULT 'pending',  -- 'pending' | 'answered' | 'applied' | 'dismissed'
  applied_rule TEXT,
  phase TEXT,
  importance INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  answered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_items_pending
  ON ai_feedback_items(created_at DESC) WHERE status = 'pending';
ALTER TABLE ai_feedback_items DISABLE ROW LEVEL SECURITY;

-- trigger_action_rules.conversation_status（aix/suggest でステータス別フィルタに使用）
-- 本番には既に存在するが migrate-schema 未定義だったため追記
ALTER TABLE trigger_action_rules ADD COLUMN IF NOT EXISTS conversation_status TEXT DEFAULT NULL;

-- scheduled_messages: 予約送信テーブル（screening-admin から sync / send-scheduled-messages cron が送信）
-- 本番には既に存在するが migrate-schema 未定義だったため追記
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL,
  line_user_id TEXT NOT NULL,
  account TEXT,
  text TEXT,
  image_urls JSONB DEFAULT '[]',
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'pending',
  error TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_scheduled_at ON scheduled_messages(scheduled_at, status);
ALTER TABLE scheduled_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS is_aix BOOLEAN DEFAULT FALSE;
-- status CHECK制約の更新（2026-07-22）: 旧制約は 'sending'（アトミッククレーム）と 'failed_ack'（UI通知済み）を
-- 許可しておらず、send-scheduled-messages cron が毎分400エラーで全件スキップしていた（本番適用済み・冪等）
ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_status_check;
ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'failed_ack'::text, 'cancelled'::text]));

-- calendar_events: 内覧カレンダー（screening-admin から sync → calendarSlots.ts が参照）
-- 本番には既に存在するが migrate-schema 未定義だったため追記
CREATE TABLE IF NOT EXISTS calendar_events (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'other',
  customer_name TEXT,
  conversation_id TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ,
  all_day BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_start_at ON calendar_events(start_at);
ALTER TABLE calendar_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events ALTER COLUMN conversation_id TYPE TEXT USING conversation_id::TEXT;

-- ── 追加カラム（2026-07-12）──

-- aix_feature_suggestions: 実装メモ用カラム + 実装完了インデックス
ALTER TABLE aix_feature_suggestions ADD COLUMN IF NOT EXISTS implementation_notes TEXT;
ALTER TABLE aix_feature_suggestions ADD COLUMN IF NOT EXISTS proposal_category TEXT DEFAULT 'other';
CREATE INDEX IF NOT EXISTS idx_aix_feature_suggestions_implemented
  ON aix_feature_suggestions(created_at DESC) WHERE status = 'implemented';

-- ai_feedback_items: 却下理由（AI質問の却下パターンを corpus2skill の学習材料に）
ALTER TABLE ai_feedback_items ADD COLUMN IF NOT EXISTS dismissed_reason TEXT;

-- ai_feedback_items: phase / importance（既存テーブル向けの追加。CREATE TABLE 定義にも同カラムあり）
ALTER TABLE ai_feedback_items ADD COLUMN IF NOT EXISTS phase TEXT;
ALTER TABLE ai_feedback_items ADD COLUMN IF NOT EXISTS importance INTEGER;
CREATE INDEX IF NOT EXISTS idx_ai_feedback_items_phase ON ai_feedback_items(phase);

-- ai_reply_knowledge: 出所管理（corpus2skill起票・手動・FEEDBACK回答などを区別）
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';

-- ── RLHF精密化 + aix_generate_log（2026-07-12）──

-- update_knowledge_feedback_by_ids: ナレッジ単位のRLHF精密フィードバック
-- phrase/pattern がsentReplyに残っているか個別判定して呼ぶ。confirm_knowledge_feedback の精密版
CREATE OR REPLACE FUNCTION update_knowledge_feedback_by_ids(
  p_correct_ids UUID[],
  p_wrong_ids UUID[]
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_correct_ids IS NOT NULL AND ARRAY_LENGTH(p_correct_ids, 1) > 0 THEN
    UPDATE knowledge_apply_log SET result = 'correct'
    WHERE knowledge_id = ANY(p_correct_ids) AND result = 'pending';
    UPDATE ai_reply_knowledge
    SET apply_count   = COALESCE(apply_count, 0) + 1,
        correct_count = COALESCE(correct_count, 0) + 1,
        last_applied_at = NOW()
    WHERE id = ANY(p_correct_ids);
  END IF;
  IF p_wrong_ids IS NOT NULL AND ARRAY_LENGTH(p_wrong_ids, 1) > 0 THEN
    UPDATE knowledge_apply_log SET result = 'wrong'
    WHERE knowledge_id = ANY(p_wrong_ids) AND result = 'pending';
    UPDATE ai_reply_knowledge
    SET apply_count = COALESCE(apply_count, 0) + 1,
        wrong_count = COALESCE(wrong_count, 0) + 1,
        last_applied_at = NOW()
    WHERE id = ANY(p_wrong_ids);
  END IF;
  UPDATE ai_reply_knowledge
  SET hypothesis_status = CASE
    WHEN apply_count >= 5 AND correct_count::float / NULLIF(apply_count::float, 0) >= 0.7 THEN 'confirmed'
    WHEN apply_count >= 5 AND wrong_count::float   / NULLIF(apply_count::float, 0) >= 0.7 THEN 'rejected'
    ELSE hypothesis_status
  END
  WHERE id = ANY(ARRAY_CAT(COALESCE(p_correct_ids, ARRAY[]::UUID[]), COALESCE(p_wrong_ids, ARRAY[]::UUID[])))
    AND apply_count >= 5;
END;
$$;

-- aix_generate_log: AIXアクションが文案を生成したイベントを記録する
-- status: generated（生成済み・送信確認待ち）/ used（送信確認済み）/ discarded（24h経過で破棄）
CREATE TABLE IF NOT EXISTS aix_generate_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type TEXT NOT NULL,
  conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'generated',
  generated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aix_generate_log_conversation ON aix_generate_log(conversation_id, status, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_aix_generate_log_status ON aix_generate_log(status, generated_at DESC);
ALTER TABLE aix_generate_log DISABLE ROW LEVEL SECURITY;

-- ── isFullRewrite tracking + confirmed 再検証 + decay統合（2026-07-12追加）──

-- ai_reply_examples: 完全手書き（AI文案ほぼ不使用）フラグ
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS is_full_rewrite BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_ai_reply_examples_full_rewrite ON ai_reply_examples(created_at DESC) WHERE is_full_rewrite = true;

-- decay_knowledge_importance: importance が 3以下まで落ちて confirmed の場合は hypothesis に差し戻す
CREATE OR REPLACE FUNCTION decay_knowledge_importance(p_ids UUID[])
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ai_reply_knowledge
  SET
    importance = GREATEST(1, COALESCE(importance, 5) - 1),
    hypothesis_status = CASE
      WHEN GREATEST(1, COALESCE(importance, 5) - 1) <= 3 AND hypothesis_status = 'confirmed' THEN 'hypothesis'
      ELSE hypothesis_status
    END
  WHERE id = ANY(p_ids);
END;
$$;

-- ── ギャップ修正（2026-07-12）──

-- aix_feature_suggestions: updated_at（corpus2skill の dismissedSuggestions/approvedSuggestions クエリが参照）
ALTER TABLE aix_feature_suggestions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- aix_generate_log: generated_text（analyzeAixMismatch の mismatch 分析と aix/action finalizeResponse で保存）
ALTER TABLE aix_generate_log ADD COLUMN IF NOT EXISTS generated_text TEXT;

-- aix_generate_log: check_pattern（property_check_result のサブパターン。aix-weekly-learning の
-- 線引き質問を check_pattern 粒度で起票し、BOUNDARY-*-aix を condition_key='check_pattern' で保存するための集計元）
ALTER TABLE aix_generate_log ADD COLUMN IF NOT EXISTS check_pattern TEXT DEFAULT NULL;

-- update_knowledge_feedback_by_ids: apply_count double-counting 修正
-- 同一 knowledge_id が p_correct_ids と p_wrong_ids 両方に含まれる場合、apply_count が +2 になるバグを修正
-- apply_count はユニーク ID の union に対して +1 のみ。correct/wrong_count は独立して加算
CREATE OR REPLACE FUNCTION update_knowledge_feedback_by_ids(
  p_correct_ids UUID[],
  p_wrong_ids UUID[]
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- apply_count: 両リストの union（重複排除）に対して +1
  UPDATE ai_reply_knowledge
  SET apply_count = COALESCE(apply_count, 0) + 1,
      last_applied_at = NOW()
  WHERE id = ANY(ARRAY(
    SELECT DISTINCT unnest(
      ARRAY_CAT(
        COALESCE(p_correct_ids, ARRAY[]::UUID[]),
        COALESCE(p_wrong_ids, ARRAY[]::UUID[])
      )
    )
  ));

  IF p_correct_ids IS NOT NULL AND ARRAY_LENGTH(p_correct_ids, 1) > 0 THEN
    UPDATE knowledge_apply_log SET result = 'correct'
    WHERE knowledge_id = ANY(p_correct_ids) AND result = 'pending';
    UPDATE ai_reply_knowledge
    SET correct_count = COALESCE(correct_count, 0) + 1
    WHERE id = ANY(p_correct_ids);
  END IF;

  IF p_wrong_ids IS NOT NULL AND ARRAY_LENGTH(p_wrong_ids, 1) > 0 THEN
    UPDATE knowledge_apply_log SET result = 'wrong'
    WHERE knowledge_id = ANY(p_wrong_ids) AND result = 'pending';
    UPDATE ai_reply_knowledge
    SET wrong_count = COALESCE(wrong_count, 0) + 1
    WHERE id = ANY(p_wrong_ids);
  END IF;

  UPDATE ai_reply_knowledge
  SET hypothesis_status = CASE
    WHEN apply_count >= 5 AND correct_count::float / NULLIF(apply_count::float, 0) >= 0.7 THEN 'confirmed'
    WHEN apply_count >= 5 AND wrong_count::float   / NULLIF(apply_count::float, 0) >= 0.7 THEN 'rejected'
    ELSE hypothesis_status
  END
  WHERE id = ANY(ARRAY_CAT(COALESCE(p_correct_ids, ARRAY[]::UUID[]), COALESCE(p_wrong_ids, ARRAY[]::UUID[])))
    AND apply_count >= 5;
END;
$$;

-- ── ナレッジ品質改善①〜⑤（2026-07-13）──

-- ③ knowledge_apply_log: result に 'expired' を追加（14日超pendingのTTL用・update-knowledge cronが更新）
ALTER TABLE knowledge_apply_log DROP CONSTRAINT IF EXISTS knowledge_apply_log_result_check;
ALTER TABLE knowledge_apply_log ADD CONSTRAINT knowledge_apply_log_result_check
  CHECK (result IN ('pending', 'correct', 'wrong', 'expired'));

-- ④ knowledge_apply_log: フィードバック経路の分離記録
-- 値: 'text_retention'（送信文への残存判定 = save-reply-example）
--     | 'reaction_72h'（72h顧客反応 = eval-customer-reaction）
--     | 'deal_outcome'（成約/失注 = eval-winning-pattern）| null
ALTER TABLE knowledge_apply_log ADD COLUMN IF NOT EXISTS feedback_source TEXT;

-- ⑤ ai_reply_knowledge: 昇格経路・昇格時刻の記録（promoteToConfirmed が書き込む）
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS promoted_by TEXT;
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;

-- ⑥ ai_reply_knowledge: 最終apply時刻（stale decay の基準を created_at → last_applied_at に切替）
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS last_applied_at TIMESTAMPTZ;

-- ① update_knowledge_feedback_by_pairs: (knowledge_id × conversation_id) ペア単位のRLHFフィードバック
-- 旧 update_knowledge_feedback_by_ids は WHERE knowledge_id = ANY(...) AND result='pending' のみで
-- 更新するため、あるナレッジを1会話で correct 判定すると別会話の pending ログまで塗り替える混線バグがあった。
-- 互換性のため旧RPCは残し、呼び出し元は本RPCへ移行済み。
-- p_correct_pairs / p_wrong_pairs: [{"knowledge_id":"...","conversation_id":"..."}] 形式のJSONB配列
-- p_feedback_source: 'text_retention' | 'reaction_72h' | 'deal_outcome'（渡されれば knowledge_apply_log に記録）
CREATE OR REPLACE FUNCTION update_knowledge_feedback_by_pairs(
  p_correct_pairs JSONB DEFAULT NULL,
  p_wrong_pairs JSONB DEFAULT NULL,
  p_feedback_source TEXT DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_correct_pairs IS NOT NULL AND jsonb_array_length(p_correct_pairs) > 0 THEN
    UPDATE knowledge_apply_log
    SET result = 'correct',
        feedback_source = COALESCE(p_feedback_source, feedback_source)
    WHERE result = 'pending'
      AND (knowledge_id::text, conversation_id) IN (
        SELECT elem->>'knowledge_id', elem->>'conversation_id'
        FROM jsonb_array_elements(p_correct_pairs) AS elem
      );
    -- apply_count / correct_count: そのナレッジが含まれるペア数（=適用会話数）だけ加算
    UPDATE ai_reply_knowledge k
    SET correct_count = COALESCE(k.correct_count, 0) + sub.cnt,
        apply_count   = COALESCE(k.apply_count, 0) + sub.cnt,
        last_applied_at = NOW()
    FROM (
      SELECT (elem->>'knowledge_id')::uuid AS kid, count(*) AS cnt
      FROM jsonb_array_elements(p_correct_pairs) AS elem
      GROUP BY 1
    ) sub
    WHERE k.id = sub.kid;
  END IF;
  IF p_wrong_pairs IS NOT NULL AND jsonb_array_length(p_wrong_pairs) > 0 THEN
    UPDATE knowledge_apply_log
    SET result = 'wrong',
        feedback_source = COALESCE(p_feedback_source, feedback_source)
    WHERE result = 'pending'
      AND (knowledge_id::text, conversation_id) IN (
        SELECT elem->>'knowledge_id', elem->>'conversation_id'
        FROM jsonb_array_elements(p_wrong_pairs) AS elem
      );
    UPDATE ai_reply_knowledge k
    SET wrong_count = COALESCE(k.wrong_count, 0) + sub.cnt,
        apply_count = COALESCE(k.apply_count, 0) + sub.cnt,
        last_applied_at = NOW()
    FROM (
      SELECT (elem->>'knowledge_id')::uuid AS kid, count(*) AS cnt
      FROM jsonb_array_elements(p_wrong_pairs) AS elem
      GROUP BY 1
    ) sub
    WHERE k.id = sub.kid;
  END IF;
  -- 5回以上適用で自動昇格/降格（update_knowledge_feedback_by_ids と同一基準）
  UPDATE ai_reply_knowledge
  SET hypothesis_status = CASE
    WHEN apply_count >= 5 AND correct_count::float / NULLIF(apply_count::float, 0) >= 0.7 THEN 'confirmed'
    WHEN apply_count >= 5 AND wrong_count::float   / NULLIF(apply_count::float, 0) >= 0.7 THEN 'rejected'
    ELSE hypothesis_status
  END
  WHERE id IN (
    SELECT DISTINCT (elem->>'knowledge_id')::uuid
    FROM jsonb_array_elements(
      COALESCE(p_correct_pairs, '[]'::jsonb) || COALESCE(p_wrong_pairs, '[]'::jsonb)
    ) AS elem
  )
    AND apply_count >= 5;
END;
$$;

-- 誤学習ブロックテーブル（「✗ 間違い」で削除したトークンの再学習を永久に防止）
CREATE TABLE IF NOT EXISTS token_block (
  token TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('station', 'region')),
  blocked_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE token_block DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_token_block_token ON token_block(token);

-- ── Fix-1c: AIX提案キャッシュ（2026-07-13）──
-- webhook受信時にバックグラウンドで先行計算したAIX提案を保持する。
-- deriveSuggestedAix() がこのキャッシュを最初に参照することでネットワーク呼び出しを省略できる。
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS suggested_next_aix TEXT;

-- ── スマートナレッジフロー（2026-07-13）──

-- ai_reply_knowledge: 曖昧フラグ（タイトルが短い・条件記述がない hypothesis を UI でフィルタ表示する）
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS needs_clarification BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_ai_reply_knowledge_needs_clarification
  ON ai_reply_knowledge(needs_clarification) WHERE needs_clarification = true;

-- ai_reply_knowledge: 矛盾リンク（このナレッジと矛盾する既存ナレッジの id を記録）
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS contradicts_id UUID REFERENCES ai_reply_knowledge(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ai_reply_knowledge_contradicts ON ai_reply_knowledge(contradicts_id) WHERE contradicts_id IS NOT NULL;

-- aix_feature_suggestions: knowledge_contradiction / knowledge_brushup 型を追加
-- （suggestion_type は TEXT のため ALTER CHECK 不要。既存のインデックスとスキーマはそのまま使用）
-- note: suggestion_type の新しい値は 'knowledge_contradiction' | 'knowledge_brushup'

-- aix_feature_suggestions: alignment_fix 型を追加（2026-07-14）
-- save-reply-example が was_ai_modified=true の送信からズレ（date_mismatch / time_mismatch /
-- number_mismatch / large_rewrite）を自動検出して起票する。新カラムなし（TEXT のため DDL 不要）

-- ── ai_prompt_rules rule_key プレフィックス規約 ──
-- HUMAN-{knowledge_id}  : 竹内さんが直接確認・修正した知識。priority=10（最高優先）・グローバル(action_type=null)・永続。
--                         knowledge-review clarify アクション経由で書き込まれる。削除しない限り常に最上位で注入される。
-- LEARN-{knowledge_id}  : ai_reply_knowledge confirmed昇格時に自動同期。priority=8。conversation_stateに応じてスコープ付き。
-- FEEDBACK-{id}-{n}     : AI盲点フィードバック（ai-feedback POST）で書き込まれる。priority=8。MAX_FEEDBACK_RULES=60件上限。
-- FEEDBACK-{id}-{n}-gr  : 同上のgenerate-replyコピー。priority=7。
-- 優先順位: HUMAN(10) > LEARN(8) = FEEDBACK(8) > FEEDBACK-gr(7)

-- ── importance ブースト冷却（2026-07-14）──
-- ai_reply_knowledge: 最終ブースト時刻（analyze-diffs ポジティブ強化Bの7日クールダウン用）
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS last_boosted_at TIMESTAMPTZ;

-- ── Chrome拡張フィードバックテーブル（2026-07-15）──
-- popup.js から駅エリア不一致・バグ報告などを受け取り蓄積する。
-- category: station_area_mismatch | station_map_request | bug_report | other
-- site: realpro | itandi | reins（フィードバック発生元サイト）
-- resolved: 管理者が対応済みにした場合 true
CREATE TABLE IF NOT EXISTS public.chrome_extension_feedback (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  category   TEXT NOT NULL,
  content    TEXT NOT NULL,
  area_raw   TEXT,
  token      TEXT,
  site       TEXT,
  resolved   BOOLEAN DEFAULT false
);
ALTER TABLE chrome_extension_feedback DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_chrome_extension_feedback_category
  ON chrome_extension_feedback(category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chrome_extension_feedback_resolved
  ON chrome_extension_feedback(resolved, created_at DESC);

-- ── find_similar_hypothesis_pairs RPC（2026-07-16）──
-- weekly-learning chunk=4 の重複排除でpg_trgm類似タイトルペアを検出するために使用
CREATE OR REPLACE FUNCTION find_similar_hypothesis_pairs(p_limit INT DEFAULT 200, p_threshold FLOAT DEFAULT 0.6)
RETURNS TABLE(
  id_a UUID,
  id_b UUID,
  title_a TEXT,
  title_b TEXT,
  imp_a INT,
  imp_b INT,
  sim_score FLOAT
) LANGUAGE sql STABLE AS $$
  WITH hypothesis_sample AS (
    SELECT id, title, importance
    FROM ai_reply_knowledge
    WHERE hypothesis_status = 'hypothesis'
      AND dedup_checked_at IS NULL
    ORDER BY importance DESC
    LIMIT p_limit
  )
  SELECT
    a.id    AS id_a,
    b.id    AS id_b,
    a.title AS title_a,
    b.title AS title_b,
    a.importance AS imp_a,
    b.importance AS imp_b,
    similarity(a.title, b.title)::FLOAT AS sim_score
  FROM hypothesis_sample a
  JOIN hypothesis_sample b ON a.id < b.id
  WHERE similarity(a.title, b.title) >= p_threshold
  ORDER BY sim_score DESC
  LIMIT 30;
$$;

-- ── hypothesis 週次レビュー管理カラム（2026-07-16）──
-- contradiction_checked_at: hypothesis × confirmed 矛盾チェック済み時刻（weekly-learning chunk=2 が打つ）
-- dedup_checked_at: hypothesis 重複排除済み時刻（weekly-learning chunk=4 が打つ）
-- rejection_reason: 自動却下・AI却下の理由コード（auto_low_quality_30d / auto_too_short / ai_contradiction / ai_redundant 等）
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS contradiction_checked_at TIMESTAMPTZ;
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS dedup_checked_at TIMESTAMPTZ;
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- ── ai_reply_examples: entry_source（AIX生成文とLINE返信案の分離）（2026-07-19）──
-- 'line_reply': page.tsx/generate-reply からの LINE返信保存（差分学習・週次学習の対象）
-- 'aix_action': AixModal からの AIX生成文保存（LINE返信学習から除外・AIXズレ分析のみ対象）
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS entry_source TEXT DEFAULT 'line_reply';
-- 既存AIX由来レコードをバックフィル（conversation_state が LINE返信ステートでないものはAIX由来）
UPDATE ai_reply_examples
SET entry_source = 'aix_action'
WHERE conversation_state NOT IN ('first_reply', 'hearing', 'proposing', 'greeting_viewing')
  AND entry_source = 'line_reply';
-- log-aix-usage が誤って 'aix' を書いていた期間のレコードを正規値に修復（2026-08-14）
UPDATE ai_reply_examples SET entry_source = 'aix_action' WHERE entry_source = 'aix';

-- ── ai_reply_examples: aix_action（AIXアクション種別の記録）（2026-07-31）──
-- AIX由来レコード（entry_source='aix_action'）がどのAIXボタン（property_recommendation /
-- viewing_invite / application_push 等・サブキー付き含む）から生成されたかを保持する。
-- analyze-diffs の反復削除検知が AI質問タイトルに「【AIX: 物件オススメ】」等のラベルを
-- 付けるために使う（質問と文脈の取り違え防止）。AixModal → save-reply-example 経由で保存。
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS aix_action TEXT;
-- バックフィル: AIX由来レコードは conversation_state にアクション名（サブキー含む）が入っている
UPDATE ai_reply_examples SET aix_action = conversation_state
WHERE entry_source = 'aix_action' AND aix_action IS NULL;

-- ── ai_feedback_items: entry_source / aix_action（AI質問の由来の構造化記録）（2026-08-02）──
-- AIX/返信の判定を【AIX: xxx】テキストタグの正規表現マッチから構造化カラムに一元化する。
-- 'line_reply': LINE返信AI由来の質問 / 'aix_action': AIXボタン生成文由来の質問 / NULL: 旧レコード（由来不明・UIで「推定」表示）
-- analyze-diffs の insertAiQuestion が起票時に必ず記録し、TemplateModal のバッジ表示と
-- ai-feedback の回答反映先分類（action_type スコープ）が同じカラムを参照する（単一真実源）。
ALTER TABLE ai_feedback_items ADD COLUMN IF NOT EXISTS entry_source TEXT;
ALTER TABLE ai_feedback_items ADD COLUMN IF NOT EXISTS aix_action TEXT;
-- バックフィル: 【AIX: xxx】タグ付きの旧起票は AIX由来として記録（タグなし旧レコードは NULL のまま）
UPDATE ai_feedback_items SET entry_source = 'aix_action'
WHERE entry_source IS NULL AND question LIKE '%【AIX%';

-- ── HUMAN-*ルール永続化（卒業メカニズム）（2026-07-20）──
-- is_permanent=true のルールはLIMITなしで最優先注入される「永久ルール」。
-- 通常の HUMAN-*(50件上限)とは別枠で常に全件注入されるため、どれほどルールが増えても
-- 永久ルールは絶対に抜け落ちない。fetchPromptRules() が別クエリで先行取得する。
ALTER TABLE ai_prompt_rules ADD COLUMN IF NOT EXISTS is_permanent BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_ai_prompt_rules_permanent ON ai_prompt_rules(is_permanent) WHERE is_permanent = TRUE;

-- FEEDBACK-* ルールの生成元 ai_feedback_items.id を追跡するカラム（2026-07-20）
-- choice='new' で旧ナレッジに紐づく FEEDBACK-* を無効化する際に、
-- rule_key の UUID 部分（feedback item id）と ai_reply_knowledge.id を誤照合するバグを修正するために追加。
ALTER TABLE ai_prompt_rules ADD COLUMN IF NOT EXISTS source_feedback_item_id UUID;

-- ── draft失敗カウント・エラー記録（2026-07-20）──
-- generate-pending-drafts が下書き生成に失敗した回数とエラー内容を記録する。
-- draft_fail_count: 連続失敗回数（3回超えたらスキップ対象にする等の制御に使う）
-- draft_last_error: 直近失敗時のエラーメッセージ（デバッグ用）
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS draft_fail_count INTEGER DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS draft_last_error TEXT;

-- ── reply_mode_decision: シャドーモード分類器の判定結果（2026-07-24）──
-- {mode, suggestedAction, matchedRule, confidence, shortDraft?, for_message_id, decided_at} を保持する
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS reply_mode_decision JSONB;
COMMENT ON COLUMN conversations.reply_mode_decision IS 'シャドーモード分類器の判定結果 {mode, suggestedAction, matchedRule, confidence, shortDraft?, for_message_id, decided_at}';

-- ── reply_mode_shadow_logs: 分類器判定の追記ログ（2026-07-24）──
-- 1メッセージ1行・上書きなし。eval cronが actual_mode/matched を後から埋める
CREATE TABLE IF NOT EXISTS reply_mode_shadow_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  customer_message_preview TEXT,
  predicted_mode TEXT NOT NULL,
  suggested_action TEXT,
  matched_rule TEXT NOT NULL,
  confidence TEXT NOT NULL,
  short_draft TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actual_mode TEXT,
  actual_aix_type TEXT,
  matched BOOLEAN,
  evaluated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reply_mode_shadow_logs_conversation_id ON reply_mode_shadow_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_reply_mode_shadow_logs_decided_at ON reply_mode_shadow_logs(decided_at);
CREATE INDEX IF NOT EXISTS idx_reply_mode_shadow_logs_evaluated_at ON reply_mode_shadow_logs(evaluated_at) WHERE evaluated_at IS NULL;

-- ── ai_similarity + isFullRewrite閾値修正（2026-07-29追加）──

-- ai_reply_examples: AI文案と送信文の類似度生値（方向性OK率を任意閾値で計算するため）
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS ai_similarity float;

-- ── prompt_candidates: プロンプト候補ピッカー（2026-07-30追加）──
-- 週次cron（prompt-candidate-gen）が回答済みAI質問を横断分析して
-- 「固定プロンプトにもルールにも無い欠落」の候補を生成 → 承認待ちキューに投入する
CREATE TABLE IF NOT EXISTS prompt_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,        -- ルール候補文（承認時に ai_prompt_rules.rule_text になる文）
  reason TEXT,                  -- なぜ固定プロンプトで補えていないかの説明
  category TEXT,                -- 'gap' | 'clarification' | 'new_scene' | 'contradiction_fix'
  action_type TEXT,             -- 対象AIXアクション（ai_prompt_rules.action_type に引き継ぐ）
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  week_label TEXT,              -- '2026-W31' 形式
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE prompt_candidates ADD COLUMN IF NOT EXISTS action_type TEXT;
CREATE INDEX IF NOT EXISTS idx_prompt_candidates_pending
  ON prompt_candidates(created_at DESC) WHERE status = 'pending';
ALTER TABLE prompt_candidates DISABLE ROW LEVEL SECURITY;

-- ── suggested_aix_meta: AIX提案の付随メタデータ（2026-08-03追加）──
-- suggested_next_aix（TEXT）に対する構造化メタ情報を保持するJSONBカラム。
-- 提案の根拠・サブモード・信頼度などを格納し、提案バナー表示や学習ループが参照する。
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS suggested_aix_meta JSONB DEFAULT NULL;

-- ── PostgREST スキーマキャッシュ再読込（必ず最後に実行する）──
-- 新カラム追加後に PostgREST のスキーマキャッシュが古いままだと、
-- 以降の INSERT/SELECT が「column does not exist」で全滅する
-- （2026-07: is_full_rewrite カラムで save-reply-example が207回連続失敗した事故の恒久対策）。

-- automation_commands テーブル（物件検索一括自動化コマンドキュー）（2026-08-05）
-- Chrome拡張 / PC自動起動フローが「全顧客分まとめて物件検索してLINEグループ送信」を
-- 非同期で実行するためのコマンドキュー。status: pending→running→done/error の3ステップ遷移。
CREATE TABLE IF NOT EXISTS automation_commands (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  command_type text NOT NULL DEFAULT 'batch_property_search',
  customer_ids text[],
  sites text[] NOT NULL DEFAULT ARRAY['reins'],
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'error')),
  total_customers int DEFAULT 0,
  processed_customers int DEFAULT 0,
  results jsonb DEFAULT '{}',
  error_message text,
  picked_up_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS automation_commands_status_idx ON automation_commands (status, created_at);

-- scrape_and_compare コマンドの顧客情報・条件を格納するペイロードカラム（2026-08-06）
-- customers/page.tsx の handleScrapeCompare が INSERT 時に使用
ALTER TABLE automation_commands ADD COLUMN IF NOT EXISTS payload jsonb;

-- ── 物件検索条件 自動読み取り・インテント分類対応（2026-08-06）──

-- 除外エリア専用カラム（ng_points は汎用NG条件、exclusion_areas はエリア除外専用として分離）
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS exclusion_areas TEXT;

-- unknown_tokens テーブル（未解決地名トークンの学習・DeepSeek解決キャッシュ）（2026-08-06）
-- resolve-search-conditions の3段フォールバック（CONCEPT_AREA_MAP → 本テーブル → DeepSeek）の学習正本。
-- resolved_as: {"type":"station","names":[...]} | {"type":"ward","names":[...]} | NULL（未解決）
-- resolution_type: 'deepseek' | 'manual'（手動登録で次回から自動解決） | 'unresolved' | NULL
-- to_review=TRUE の行は将来AI提案タブ等で人間レビュー対象
CREATE TABLE IF NOT EXISTS unknown_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  resolution_type TEXT,
  resolved_as JSONB,
  to_review BOOLEAN NOT NULL DEFAULT FALSE,
  attempt_count INT NOT NULL DEFAULT 1,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_unknown_tokens_token ON unknown_tokens (token);
ALTER TABLE unknown_tokens DISABLE ROW LEVEL SECURITY;

-- ── 町字絞り込み（リアプロ town_code[] 対応）（2026-08-06）──
-- Chrome拡張の popup-maps.js TOWN_CODE_MAP と連携して顧客の希望町字を保存する。
-- 値: ['安立', '北加賀屋'] 等の町字名配列（TOWN_CODE_MAP でtown_code[]値に変換してリアプロに設定）
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS town_names text[];

-- 隣接駅OK（条件緩和フラグ）（2026-08-06追加）
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS adjacent_ok BOOLEAN DEFAULT FALSE;

-- rp_update_days: アプリから設定する更新日フィルター上書き（1/3/7/14日・NULLは自動計算）（2026-08-08）
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS rp_update_days INTEGER;

-- area_mode: 物件検索モード（auto/ward/station/both）をDBに永続化（2026-08-08追加）
-- 'auto'=自動判定 / 'ward'=地域のみ / 'station'=駅のみ / 'both'=両方同時検索。DEFAULT 'auto'
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS area_mode TEXT DEFAULT 'auto';

-- last_judged_at: bulk-judge-knowledge が審査した時刻（重複審査防止・14日フィルター用）（2026-08-11）
ALTER TABLE ai_reply_knowledge ADD COLUMN IF NOT EXISTS last_judged_at TIMESTAMPTZ;

-- 通勤先駅・通勤時間（指定ある顧客用。徒歩分とは別バッジで表示）（2026-08-12）
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS commute_station TEXT;
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS commute_minutes INTEGER;

-- ── conversation_checkpoints: 会話チェックポイント（15件ごとのAI要約）（2026-08-13）──
-- 15件ごとのメッセージブロックをHaikuが要約・重要事実を抽出して保存する。
-- generate-reply が長期会話でも全履歴を読まずに文脈を把握するための圧縮メモリ。
-- 2026-08-14〜 ローリング累積方式に変更: brain-core.ts maybeCreateCheckpoint が単一writer。
--   checkpoint_index は単純連番・最新indexの summary が現在の確認済み事実の全量（ground truth）。
--   final-check anomaly_scan の正解データとしても使用。旧ブロック方式writer
--   （create-checkpoint / cron/create-checkpoints）は停止済み・併用禁止。
-- key_facts: [{"type":"confirmed_fact"|"aix_sent"|"unresolved","value":"..."}, ...]
-- conversation_stage: hearing/proposing/applying/contract（チェックポイント生成時点のステージ）
CREATE TABLE IF NOT EXISTS conversation_checkpoints (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  checkpoint_index INTEGER NOT NULL,
  message_count_at_creation INTEGER NOT NULL,
  summary TEXT NOT NULL,
  key_facts JSONB DEFAULT '[]',
  conversation_stage TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(conversation_id, checkpoint_index)
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_conversation ON conversation_checkpoints(conversation_id, checkpoint_index DESC);
ALTER TABLE conversation_checkpoints DISABLE ROW LEVEL SECURITY;

-- ── closing_strategy_logs: クロージング戦略ログ（2026-08-13）──
-- deriveSuggestedAix が closing_strategy を生成するたびに記録する。
-- outcome: 'contract'（成約）/ 'lost'（失注）/ NULL（未確定）
-- source: 'derive'（generate-reply経由）/ 'brain'（brain/list経由）
CREATE TABLE IF NOT EXISTS closing_strategy_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  closing_strategy TEXT NOT NULL,
  conversation_status TEXT,
  proposed_at TIMESTAMPTZ DEFAULT NOW(),
  outcome TEXT,
  outcome_recorded_at TIMESTAMPTZ,
  source TEXT DEFAULT 'derive'
);
CREATE INDEX IF NOT EXISTS idx_closing_logs_conversation
  ON closing_strategy_logs(conversation_id, proposed_at DESC);
CREATE INDEX IF NOT EXISTS idx_closing_logs_outcome
  ON closing_strategy_logs(outcome, proposed_at DESC);
ALTER TABLE closing_strategy_logs DISABLE ROW LEVEL SECURITY;

-- 送付物件履歴（2026-08-13追加）
-- AIX物件オススメ送信時に物件名・号室をVision OCRで記録。重複送付防止・送付履歴追跡に使用
CREATE TABLE IF NOT EXISTS sent_properties (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  property_customer_id UUID REFERENCES property_customers(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  property_name TEXT NOT NULL,
  room_no TEXT NOT NULL,
  image_url TEXT,
  source TEXT DEFAULT 'vision',
  sent_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sent_props_customer ON sent_properties(property_customer_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_sent_props_conversation ON sent_properties(conversation_id);
ALTER TABLE sent_properties DISABLE ROW LEVEL SECURITY;

-- ── conversation_stage_history: 会話ステータス変遷履歴（P2: 2026-08-14追加）──
-- conversations.status の変化を時系列で記録する。自動昇格・手動変更・AIXアクションの追跡に使用。
-- trigger: 'customer_message' | 'staff_reply' | 'manual' | 'aix_action' | 'cron'
CREATE TABLE IF NOT EXISTS conversation_stage_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_at TIMESTAMPTZ DEFAULT NOW(),
  trigger TEXT DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS idx_stage_history_conv ON conversation_stage_history(conversation_id, changed_at DESC);
ALTER TABLE conversation_stage_history DISABLE ROW LEVEL SECURITY;

-- ── brain_analyzed_at: 脳分析の最終試行時刻（2026-08-14追加）──
-- 成功時・失敗時の両方で書き込まれ、brain-sweep の30分リトライバックオフに使用する
-- （旧コメントの「24h TTLキャッシュ」は未実装のまま廃止 — 実設計はイベント駆動 + sweep バックオフ）
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS brain_analyzed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_conversations_brain_analyzed ON conversations(brain_analyzed_at) WHERE brain_analyzed_at IS NOT NULL;

-- ── インクリメンタル分析用フル分析水位（2026-08-19追加）──
-- brain_deep_analyzed_at: 最後にフル分析（full mode）を実行した時刻
-- brain_deep_msg_count: フル分析実行時点の総メッセージ数（30件強制リフレッシュ用）
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS brain_deep_analyzed_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS brain_deep_msg_count INTEGER DEFAULT 0;

-- ── フル脳分析キャッシュ（2026-08-19追加）──
-- brain_full_analyzed_at: 最後にフル脳分析を実行した時刻
-- brain_full_msg_count: フル分析実行時点の総メッセージ数（増分判定用）
-- last_brain_meta: 最後のフル脳分析結果のキャッシュ（JSONB）
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS brain_full_analyzed_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS brain_full_msg_count INTEGER;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_brain_meta JSONB;

-- ── reply_engagement_signals: 返信後の顧客反応シグナル（2026-08-14追加）──
-- スタッフ送信時に pending を作成し、顧客の次の返信で resolve する。
-- 時間閾値なし（LINEは返信が遅いのが普通）。返信あり=neutral、成約パターン語（内覧・申込等）検出=positive。
-- signal_type: 'pending' | 'neutral' | 'positive'
CREATE TABLE IF NOT EXISTS reply_engagement_signals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  reply_example_id UUID REFERENCES ai_reply_examples(id) ON DELETE SET NULL,
  staff_sent_at TIMESTAMPTZ NOT NULL,
  customer_replied_at TIMESTAMPTZ,
  response_minutes INTEGER,
  customer_reply_text TEXT,
  signal_type TEXT DEFAULT 'pending',
  signal_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reply_engagement_conv ON reply_engagement_signals(conversation_id, staff_sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_reply_engagement_type ON reply_engagement_signals(signal_type);
ALTER TABLE reply_engagement_signals DISABLE ROW LEVEL SECURITY;

-- ── weekly_learning_metrics: 週次学習スコアボード（Fable5 Fix3: 2026-08-14追加）──
-- weekly-learning chunk=1 が毎週 upsert する。「今週の学習は効いたのか？」に答えるボトムラインKPI。
-- unmodified_rate = AI案がそのまま送信された率 / mean_edit_distance = AI案→送信文の平均文字編集距離
CREATE TABLE IF NOT EXISTS weekly_learning_metrics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  week_start DATE NOT NULL UNIQUE,
  total_replies INTEGER NOT NULL DEFAULT 0,
  ai_draft_replies INTEGER NOT NULL DEFAULT 0,
  handwritten_count INTEGER NOT NULL DEFAULT 0,
  unmodified_count INTEGER NOT NULL DEFAULT 0,
  unmodified_rate NUMERIC,
  mean_edit_distance NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE weekly_learning_metrics DISABLE ROW LEVEL SECURITY;

-- ── ai_draft_check: AI返信最終チェック結果（前頭前野モデル・2026-08-14追加）──
-- generate-reply が ai_draft 保存時に併せて保存する CheckResult JSON
-- { ok, issues[], revised_text?, passes_completed[], elapsed_ms, checked_text_hash }
-- 送信時にクライアントが checked_text_hash と textToSend の sha1 を照合し、
-- 一致（未編集）なら再チェックなしで即送信 / 不一致（スタッフ編集）なら /api/check-reply で再チェック
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_draft_check JSONB;

-- ── positive_source: 「未修正=正解」ポジティブ強化の識別子（2026-08-14追加）──
-- analyze-diffs ポジティブ強化D が was_ai_modified=false（AI案そのまま送信=正解シグナル）の例を
-- 自動☆付与＋ナレッジ used_count ブーストした際に 'no_edit_positive' を記録する。
-- 値が入っている = 処理済み（毎日のcronでの重複処理防止フラグを兼ねる）
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS positive_source TEXT;

-- ── 申込到達自動学習（analyze-applying: 2026-08-14追加）──
-- conversations.learned_at: /api/analyze-applying が申込到達会話の学習処理を完了した時刻。
-- NULL = 未学習（処理対象）。学習失敗時は更新されず次回実行で再試行される（フェイルオープン）。
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS learned_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_conversations_learned_at ON conversations(status) WHERE learned_at IS NULL;

-- ai_reply_examples.application_success: 申込到達会話の☆つき例（特に重要な成功例）フラグ
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS application_success BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_ai_reply_examples_app_success ON ai_reply_examples(application_success) WHERE application_success = TRUE;

-- ai_reply_knowledge.category に 'applying_pattern'（申込到達パターン専用カテゴリ）を追加
-- ※ L174 の CREATE TABLE 時 CHECK は既存テーブルには効かないため、制約を張り替える
ALTER TABLE ai_reply_knowledge DROP CONSTRAINT IF EXISTS ai_reply_knowledge_category_check;
ALTER TABLE ai_reply_knowledge ADD CONSTRAINT ai_reply_knowledge_category_check
  CHECK (category IN ('pattern', 'style', 'phrase', 'principle', 'applying_pattern'));

-- conversation_direction: 会話の方向性・フェーズ情報（JSONB）（2026-08-14追加）
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS conversation_direction jsonb DEFAULT NULL;

-- area_normalized: DeepSeekが正規化したエリア希望文字列（2026-08-17追加）
-- desired_area がひらがな・略称・口語表現の場合に正式駅名/市区名に変換した結果を保存する。
-- 例: "なんば" → "難波", "天六" → "天神橋筋六丁目", "北摂あたり" → "豊中市・吹田市・茨木市"
-- Chrome拡張の resolve-area API が判定・書き込む。UI側は desired_area を直接変更しない。
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS area_normalized TEXT;

-- viewing_history テーブル（内覧履歴・複数内覧対応・is_primaryで最新管理）（2026-08-15追加）
-- viewingsテーブルの後継。scheduled_date（予定日）/ actual_date（実際の内覧日）/ is_primary（最新フラグ）を持つ
CREATE TABLE IF NOT EXISTS viewing_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  customer_name TEXT,
  scheduled_date DATE NOT NULL,
  scheduled_time TEXT,
  actual_date DATE,
  status TEXT DEFAULT 'scheduled',
  is_primary BOOLEAN DEFAULT FALSE,
  pre_announce_sent BOOLEAN DEFAULT FALSE,
  post_announce_sent BOOLEAN DEFAULT FALSE,
  cheer_sent BOOLEAN DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_viewing_history_conversation ON viewing_history(conversation_id);
CREATE INDEX IF NOT EXISTS idx_viewing_history_scheduled_date ON viewing_history(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_viewing_history_is_primary ON viewing_history(conversation_id) WHERE is_primary = TRUE;
ALTER TABLE viewing_history DISABLE ROW LEVEL SECURITY;

-- ── templates.won_count: テンプレート成約実績（2026-08-15追加）──
-- analyze-applying が closed_won 会話の自発送信（手打ち含む）と templates.text を
-- 突き合わせて自動集計する「成約会話で実際に使われた回数」。
-- brain-core のテンプレート選択で最優先指標として参照する（won_count DESC）。
ALTER TABLE templates ADD COLUMN IF NOT EXISTS won_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS templates_won_count_idx ON templates (won_count DESC);

-- ── brain_decision_logs: Brain判断ログ・スタッフ行動成否記録（2026-08-18追加）──
-- Brain（analyzeAndSaveBrainMeta）が会話を分析して出した提案を記録し、
-- スタッフが実際に取った行動（AIX従った・下書き使った・無視した）との突合に使う。
CREATE TABLE IF NOT EXISTS brain_decision_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suggested_action TEXT,
  suggested_reply_mode TEXT,
  suggested_next_steps JSONB,
  enforcement_level TEXT,
  conversation_status TEXT,
  source TEXT DEFAULT 'brain_core',
  outcome TEXT,
  outcome_recorded_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_brain_decision_logs_conversation_id ON brain_decision_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_brain_decision_logs_created_at ON brain_decision_logs(created_at DESC);
ALTER TABLE brain_decision_logs DISABLE ROW LEVEL SECURITY;

-- ── brain_meta_insights: 竹内の改善思考パターン蓄積（2026-08-20追加）──
-- Brainがいずれ自律的に改善提案できるようにするための知識ベース。
-- 竹内が新しい改善パターン・哲学を発見したら都度INSERT。
-- 将来: brain-coreのフル分析プロンプトがこのテーブルを参照し「過去の改善パターンに基づいた提案」を生成。
CREATE TABLE IF NOT EXISTS brain_meta_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL CHECK (category IN ('cost_reduction', 'quality_improvement', 'architecture', 'user_philosophy')),
  title TEXT NOT NULL,
  principle TEXT NOT NULL,
  pattern TEXT,
  example TEXT,
  result TEXT,
  impact TEXT CHECK (impact IN ('high', 'medium', 'low')),
  source TEXT DEFAULT 'takeuchi',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_brain_meta_insights_category ON brain_meta_insights(category);
ALTER TABLE brain_meta_insights DISABLE ROW LEVEL SECURITY;

-- design_knowledge テーブル（LP/HP制作ノウハウ蓄積・Claudeが次回から活用）
-- brain_kt.md のデザイン版。案件ごとに学んだ判断軸・失敗パターン・UX軸を蓄積する
CREATE TABLE IF NOT EXISTS design_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL CHECK (category IN ('最初にやること', '避けるべきパターン', 'UX軸', 'デザイン軸', 'コピー軸')),
  domain TEXT NOT NULL DEFAULT 'LP' CHECK (domain IN ('LP', 'ツール', 'Chrome拡張', 'その他')),
  rule_title TEXT NOT NULL,
  rule_content TEXT NOT NULL,
  reason TEXT,
  source_project TEXT,
  importance INTEGER DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_design_knowledge_category ON design_knowledge(category);
CREATE INDEX IF NOT EXISTS idx_design_knowledge_domain ON design_knowledge(domain);
CREATE INDEX IF NOT EXISTS idx_design_knowledge_importance ON design_knowledge(importance DESC);
ALTER TABLE design_knowledge DISABLE ROW LEVEL SECURITY;

-- 初期データ（brain_kt.md のデザイン版として転記）
INSERT INTO design_knowledge (category, domain, rule_title, rule_content, reason, source_project, importance) VALUES

('最初にやること', 'LP', 'ゴールを決めてからデザインする',
 'LPの唯一のゴール（=LINE友だち追加・問い合わせ等）を最初に定義し、そこから逆算してレイアウトを決める。',
 'ゴール未定義のままデザインするとCTA配置が弱くなる。イエヤスLPでQRコードをメインにした判断はゴール先行で正しかった。',
 'イエヤスLP', 9),

('最初にやること', 'LP', '実アセットを先に集める',
 '参考URL・キャラ画像・ロゴ・コピー文言を先にもらってからFable5に投げる。ないまま作るとAI感が強くなる。',
 'QR画像・武将キャラを渡すことでデザイン精度が格段に上がった。アセット先集めが初回品質を決める。',
 'イエヤスLP', 8),

('避けるべきパターン', 'LP', 'AIっぽいグラデーションヒーロー',
 '単色→単色のグラデーションヒーロー、Inter/Space Grotesk、rounded-lgカード、01/02/03番号カードは全てNG。',
 '汎用パターンはAI感が出て大手感がなくなる。日本の大手LINEキャンペーン広告を参考にする。',
 'イエヤスLP', 9),

('避けるべきパターン', 'LP', '外部CDN依存',
 '外部フォント・外部CSSライブラリは全てインライン化する。ArtifactのCSP制限もあるが、Vercel本番でも依存を減らすのが安全。',
 'CDN障害でLPが壊れるリスクを避ける。全インライン = 完全自己完結。',
 'イエヤスLP', 7),

('UX軸', 'LP', 'LINEボタンは最低3箇所',
 'ヒーロー・中盤・固定フッターバーの3箇所にLINEボタンを設置する。スクロールどこでも追加できる状態にする。',
 'モバイルではスクロール位置によってCTA表示タイミングが変わる。固定フッターは最後の砦として必須。',
 'イエヤスLP', 8),

('UX軸', 'LP', 'TikTok WebView制限への対応',
 'TikTok WebViewではline://・Universal Link・window.openが全てブロックされる。navigator.share()のみOS経由で動作する。QRコード訴求が最も確実な突破口。',
 'Fable5×3回の調査で確定。TikTok bioリンク→LP→LINE追加フローでQRコードが唯一のTikTok制限を回避できる手段。',
 'イエヤスLP', 10),

('デザイン軸', 'LP', 'ポップ大手感の出し方',
 '黄色地・放射状サンバースト・ピンク帯バナー・漫画吹き出し・太字黒テキストの組み合わせで日本の大手アプリ広告感が出る。',
 '参考: スモラQR訴求画像。キャラクター+QR+吹き出しの構成が「3秒でカンタン」という行動誘導に効果的。',
 'イエヤスLP', 8),

('コピー軸', 'LP', 'CTAは動詞+ベネフィット形式',
 '「LINE友だち追加」より「初期費用を割引してもらう」「LINEで無料相談する」の方がクリック率が高い。行動+得られる結果を明示する。',
 'LINE公式広告のベストプラクティス。ユーザーは「なぜやるか」が見えるとタップしやすくなる。',
 'イエヤスLP', 7)

ON CONFLICT DO NOTHING;

-- ── templates RAG: embedding カラム + HNSW インデックス + RPC（2026-08-23追加）──
-- category+label のテキストをベクトル化して会話コンテキストとのコサイン類似度でテンプレを選ぶ。
-- バックフィル: /api/backfill-templates を POST して全151件に embedding を生成する。
ALTER TABLE templates ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX IF NOT EXISTS templates_embedding_idx
  ON templates USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE OR REPLACE FUNCTION match_templates(
  query_embedding vector,
  match_count integer DEFAULT 8,
  category_filter text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  category text,
  label text,
  win_rate numeric,
  use_count integer,
  won_count integer,
  similarity double precision
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    t.id,
    t.category,
    t.label,
    t.win_rate,
    t.use_count,
    t.won_count,
    (1 - (t.embedding <=> query_embedding))::float AS similarity
  FROM templates t
  WHERE t.embedding IS NOT NULL
    AND (category_filter IS NULL OR t.category LIKE category_filter)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- PostgREST スキーマキャッシュ再読込（必ず最後に実行）
SELECT pg_notify('pgrst', 'reload schema');

-- イエヤスLP ページビュートラッキング（2026-08-19追加）
CREATE TABLE IF NOT EXISTS iyeyasu_page_views (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_iyeyasu_pv_created_at ON iyeyasu_page_views(created_at DESC);
ALTER TABLE iyeyasu_page_views DISABLE ROW LEVEL SECURITY;

-- ══ Brain監査（2026-08-20）: LLM推測→DB事実化のためのカラム・テーブル追加 ══════
-- brain(suggested_aix_meta) の action / urgency_appropriate / condition_change_type /
-- current_property / key_topics をテキスト推測ではなく構造化データで接地させる。

-- ① 流入元（信号TikTokの決定論化）: webhook初回受信時にセットする
-- 'tiktok' | 'instagram' | 'organic' | 'referral' 等
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS acquisition_source TEXT;

-- ② sent_properties 拡張（募集状況・current_property の事実化）
ALTER TABLE sent_properties ADD COLUMN IF NOT EXISTS property_url TEXT;
ALTER TABLE sent_properties ADD COLUMN IF NOT EXISTS rent INTEGER;
-- 'open' | 'move_out_planned' | 'occupied' | 'closed'（MOVE_OUT_PATTERN regex推測の代替）
ALTER TABLE sent_properties ADD COLUMN IF NOT EXISTS recruitment_status TEXT;
ALTER TABLE sent_properties ADD COLUMN IF NOT EXISTS recruitment_checked_at TIMESTAMPTZ;
-- 1=一番手, 2=二番手（「（2番手・申込）」テンプレ判定・urgency_appropriate の事実根拠）
ALTER TABLE sent_properties ADD COLUMN IF NOT EXISTS applicant_rank INTEGER;
-- 'interested' | 'rejected' | 'no_response'（quoted_message_id 引用リプライから自動更新予定）
ALTER TABLE sent_properties ADD COLUMN IF NOT EXISTS customer_reaction TEXT;

-- ③ messages 拡張（画像分類・物件紐付け）
-- 'estimate' | 'floor_plan' | 'property_photo' | 'id_document' | 'other'
-- webhook受信時にVisionで1回分類 → brain信号3.5の「全画像=見積書」盲目仮定を解消
ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_type TEXT;
-- sent_properties.id への参照（URL一致・quoted_message_id 経由で自動リンク）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS referenced_property_id UUID;
CREATE INDEX IF NOT EXISTS idx_messages_referenced_property ON messages(referenced_property_id);

-- ④ 条件変更履歴（condition_change_type の事実化・property_customers は最新値しか持たない）
CREATE TABLE IF NOT EXISTS property_condition_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_customer_id UUID NOT NULL,
  changed_field TEXT NOT NULL,     -- 'desired_area' | 'rent_max' | 'floor_plan' 等
  old_value TEXT,
  new_value TEXT,
  source_message_id TEXT,          -- 変更の根拠となった messages.id
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pch_customer ON property_condition_history(property_customer_id, created_at DESC);
ALTER TABLE property_condition_history DISABLE ROW LEVEL SECURITY;

-- ⑤ line_tasks に確認結果（空室確認の回答を構造化 → urgency_appropriate / property_check_result の事実化）
-- 'available' | 'taken' | 'second_position' | 'move_out_planned'
ALTER TABLE line_tasks ADD COLUMN IF NOT EXISTS result TEXT;
ALTER TABLE line_tasks ADD COLUMN IF NOT EXISTS result_note TEXT;
ALTER TABLE line_tasks ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- ⑥ brain学習キュー（brain-as-learning-curator）: brainがAIX-META分析成功時に高品質な
-- 学習候補を積み、corpus2skill が生 ai_reply_examples より優先して消費する。
-- conversation_id UNIQUE により brain 再実行時は upsert で最新状態に上書きされる。
CREATE TABLE IF NOT EXISTS brain_learning_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL UNIQUE,      -- conversations.id（TEXT型・upsert キー）
  example_id UUID,                           -- ai_reply_examples.id（brain時点では不明・将来リンク用に nullable）
  quality_score INTEGER NOT NULL CHECK (quality_score >= 0 AND quality_score <= 10),
  pattern_tags TEXT[] DEFAULT '{}',          -- 'hesitancy:thinking' | 'stage:proposing' | 'tone:共感的' | 'action:estimate_sheet'
  brain_context JSONB DEFAULT '{}',          -- AIX-META主要フィールドのスナップショット
  novelty_signal TEXT,                       -- repeated_concern（繰り返し確認テーマ）
  processed_by_corpus2skill BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_blq_unprocessed ON brain_learning_queue(processed_by_corpus2skill, quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_blq_created_at ON brain_learning_queue(created_at DESC);
ALTER TABLE brain_learning_queue DISABLE ROW LEVEL SECURITY;

-- ── aix_brain_templates（2026-08-20追加）──
-- AIXボタン別のブレイン管轄テンプレート。
-- addendum_text: weekly-learningがbrainの学習結果から生成する追加ルール文。
-- action/route.tsは5分TTLのメモリキャッシュ経由でこれを読み込みsystemに追記する。
CREATE TABLE IF NOT EXISTS aix_brain_templates (
  action_type TEXT NOT NULL,
  sub_mode    TEXT NOT NULL DEFAULT 'default',
  addendum_text TEXT,
  quality_score INTEGER DEFAULT 5 CHECK (quality_score BETWEEN 0 AND 10),
  updated_by_brain_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (action_type, sub_mode)
);
CREATE INDEX IF NOT EXISTS idx_abt_action_type ON aix_brain_templates (action_type);
ALTER TABLE aix_brain_templates DISABLE ROW LEVEL SECURITY;

-- 申込ステータス誤昇格バグ修正（2026-08-20）: テキストと画像の両方が揃って初めて applying に昇格
-- applying_text_received: 顧客が申込フォームをテキストで送ってきた
-- applying_image_received: スタッフの申込書案内後72h以内に顧客が画像を送ってきた
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS applying_text_received BOOLEAN DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS applying_image_received BOOLEAN DEFAULT false;

-- イエヤスLP ページビュー計測テーブル
CREATE TABLE IF NOT EXISTS iyeyasu_page_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE iyeyasu_page_views DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_iyeyasu_page_views_created_at ON iyeyasu_page_views(created_at DESC);

-- ── system_design_thinking（2026-08-22追加）──
-- 設計思考・アーキテクチャ知識を蓄積するテーブル。
-- 竹内さんとClaudeが会話で生み出した設計判断・アーキテクチャ知見を蓄積し、
-- 将来のセッションでBrainやClaudeがRAG検索で過去の設計決定を参照できるようにする。
-- セッション終了時にINSERT（embedding生成は別途cronで実施）。
CREATE TABLE IF NOT EXISTS system_design_thinking (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('architecture', 'prompt_engineering', 'data_model', 'ux', 'performance', 'ai_design')),
  insight TEXT NOT NULL,
  rationale TEXT,
  context TEXT,
  applied_to TEXT,
  tags TEXT[],
  embedding vector(1536),
  is_current BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_system_design_thinking_category ON system_design_thinking(category);
CREATE INDEX IF NOT EXISTS idx_system_design_thinking_current ON system_design_thinking(is_current) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS idx_system_design_thinking_embedding ON system_design_thinking USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
ALTER TABLE system_design_thinking DISABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION match_design_thinking(
  query_embedding vector(1536),
  match_count INT DEFAULT 5,
  category_filter TEXT DEFAULT NULL
)
RETURNS TABLE(id UUID, title TEXT, category TEXT, insight TEXT, rationale TEXT, similarity FLOAT)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT dt.id, dt.title, dt.category, dt.insight, dt.rationale,
    1 - (dt.embedding <=> query_embedding) AS similarity
  FROM system_design_thinking dt
  WHERE dt.is_current = true
    AND (category_filter IS NULL OR dt.category = category_filter)
    AND dt.embedding IS NOT NULL
  ORDER BY dt.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ── line_meta: 路線マスタ（ハードコードマップのDB化・2026-08-22追加）──
-- resolve-area/route.ts の LINE_ROUTE_MAP / LINE_ALIAS_MAP / ITANDI_LINE_MAP_FILL / REINS_LINE_MAP を置き換え。
-- internal_name: 内部キー（line_stations.line_name と一致させる）
-- realpro_route_id: リアプロのルートID
-- itandi_names: ITANDIの路線名配列（複数表記対応）
-- reins_name: レインズの路線名
-- aliases: 別名・略称の配列（GINインデックスで高速検索）
CREATE TABLE IF NOT EXISTS line_meta (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_name TEXT NOT NULL UNIQUE,
  realpro_route_id TEXT,
  itandi_names TEXT[] DEFAULT '{}',
  reins_name TEXT,
  aliases TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_line_meta_internal_name ON line_meta(internal_name);
CREATE INDEX IF NOT EXISTS idx_line_meta_aliases ON line_meta USING GIN(aliases);
ALTER TABLE line_meta DISABLE ROW LEVEL SECURITY;

-- ── property_search_knowledge: 物件検索担当ブレイン（2026-08-22追加）──
-- エリア・駅の解決失敗パターン・変換ルール・顧客条件の読み取りパターンを蓄積する。
-- ai_reply_knowledge と同構造・物件検索専用のナレッジテーブル。
CREATE TABLE IF NOT EXISTS property_search_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  importance INTEGER DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  apply_count INTEGER DEFAULT 0,
  correct_count INTEGER DEFAULT 0,
  wrong_count INTEGER DEFAULT 0,
  hypothesis_status TEXT DEFAULT 'hypothesis' CHECK (hypothesis_status IN ('hypothesis', 'confirmed', 'rejected')),
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_property_search_knowledge_category ON property_search_knowledge(category);
CREATE INDEX IF NOT EXISTS idx_property_search_knowledge_importance ON property_search_knowledge(importance DESC);
ALTER TABLE property_search_knowledge DISABLE ROW LEVEL SECURITY;

-- ── ward_codes: 市区町村コード（JIS X 0402 6桁コード）(2026-08-22追加) ──
CREATE TABLE IF NOT EXISTS ward_codes (
  ward TEXT PRIMARY KEY,
  code TEXT NOT NULL
);
ALTER TABLE ward_codes DISABLE ROW LEVEL SECURITY;

-- ── town_codes: 町名コード（市区町村→町名→JIS 8桁コード）(2026-08-22追加) ──
CREATE TABLE IF NOT EXISTS town_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ward TEXT NOT NULL,
  town TEXT NOT NULL,
  town_code TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (ward, town)
);
CREATE INDEX IF NOT EXISTS idx_town_codes_ward ON town_codes(ward);
CREATE INDEX IF NOT EXISTS idx_town_codes_town_code ON town_codes(town_code);
ALTER TABLE town_codes DISABLE ROW LEVEL SECURITY;

-- ── adjacent_area_map: 隣接市区マップ（「周辺も探す」拡張用）(2026-08-22追加) ──
CREATE TABLE IF NOT EXISTS adjacent_area_map (
  ward TEXT PRIMARY KEY,
  adjacent_wards TEXT[] NOT NULL DEFAULT '{}'
);
ALTER TABLE adjacent_area_map DISABLE ROW LEVEL SECURITY;

-- ── station_hub_map: 乗換駅ハブ（同一駅の表記ゆれグルーピング）(2026-08-22追加) ──
CREATE TABLE IF NOT EXISTS station_hub_map (
  hub_station TEXT PRIMARY KEY,
  member_stations TEXT[] NOT NULL DEFAULT '{}'
);
ALTER TABLE station_hub_map DISABLE ROW LEVEL SECURITY;

-- ── metro_graph: 地下鉄路線グラフ（Dijkstra 最短経路計算用・JSONB edges）(2026-08-22追加) ──
-- edges: [{from, to, minutes, line}, ...] の配列 JSONB で1行に全路線を保持
CREATE TABLE IF NOT EXISTS metro_graph (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL,
  edges JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE metro_graph DISABLE ROW LEVEL SECURITY;

-- ── itandi_line_map: リアプロ路線名→itandi路線名変換マップ (2026-08-22追加) ──
-- realpro_line: STATION_LINE_MAPで使う内部路線名 / itandi_lines: itandiの路線名（複数の場合あり）
CREATE TABLE IF NOT EXISTS itandi_line_map (
  realpro_line TEXT PRIMARY KEY,
  itandi_lines TEXT[] NOT NULL DEFAULT '{}'
);
ALTER TABLE itandi_line_map DISABLE ROW LEVEL SECURITY;

-- ── station_map / region_map: pgvector embedding カラム（2026-08-22追加） ──
-- ハードコードで解決できない駅名・地名トークンのベクトル類似検索に使用（text-embedding-3-small 1536次元）
ALTER TABLE station_map ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE region_map  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- HNSW インデックス（コサイン距離・既存データへの事後追加も想定して IF NOT EXISTS）
CREATE INDEX IF NOT EXISTS idx_station_map_embedding ON station_map
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_region_map_embedding ON region_map
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- match_station_map RPC（/api/embed-maps バッチ後・/api/resolve-area Step2.5で呼ぶ）
CREATE OR REPLACE FUNCTION match_station_map(
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  token text, ward text, realpro_lines jsonb, itandi_lines text[], reins_line text, similarity float
)
LANGUAGE sql STABLE AS $$
  SELECT token, ward, realpro_lines, itandi_lines, reins_line,
         1 - (embedding <=> query_embedding) AS similarity
  FROM station_map
  WHERE embedding IS NOT NULL
    AND 1 - (embedding <=> query_embedding) >= match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- match_region_map RPC
CREATE OR REPLACE FUNCTION match_region_map(
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
RETURNS TABLE (token text, ward text, similarity float)
LANGUAGE sql STABLE AS $$
  SELECT token, ward,
         1 - (embedding <=> query_embedding) AS similarity
  FROM region_map
  WHERE embedding IS NOT NULL
    AND 1 - (embedding <=> query_embedding) >= match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ── customer_intent × staff_reply_intent ペア学習（2026-08-24）─────────────────────
-- ai_reply_examples: 顧客意図（保存時キーワード自動分類。brain出力を優先で受け付ける）
ALTER TABLE ai_reply_examples ADD COLUMN IF NOT EXISTS customer_intent TEXT;
CREATE INDEX IF NOT EXISTS idx_ai_reply_examples_intent ON ai_reply_examples(customer_intent) WHERE customer_intent IS NOT NULL;

-- winning_patterns: 転換点の意図ペア（analyze-closed Opusが分類・将来RAGブーストで使用）
ALTER TABLE winning_patterns ADD COLUMN IF NOT EXISTS customer_intent TEXT;
ALTER TABLE winning_patterns ADD COLUMN IF NOT EXISTS staff_reply_intent TEXT;

-- match_reply_examples: customer_intent を返り値に追加（意図一致+0.2ブーストのため）
-- ※ 返り値型変更のため DROP→CREATE が必要
DROP FUNCTION IF EXISTS match_reply_examples(vector, int, text[]);
CREATE OR REPLACE FUNCTION match_reply_examples(query_embedding vector(1536), match_count int, filter_states text[])
RETURNS TABLE (id uuid, customer_message text, sent_reply text, conversation_state text, is_starred boolean, reply_angle text, customer_intent text, similarity float)
LANGUAGE sql STABLE AS $func$
  SELECT ae.id, ae.customer_message, ae.sent_reply, ae.conversation_state, ae.is_starred, ae.reply_angle, ae.customer_intent, (1 - (ae.embedding <=> query_embedding))::float AS similarity
  FROM ai_reply_examples ae
  WHERE ae.conversation_state = ANY(filter_states)
    AND ae.embedding IS NOT NULL
    AND ae.entry_source = 'line_reply'
  ORDER BY ae.embedding <=> query_embedding
  LIMIT match_count
$func$;

-- match_winning_patterns: customer_intent / staff_reply_intent を返り値に追加（2026-08-24）
-- ※ 返り値型変更のため DROP→CREATE が必要
DROP FUNCTION IF EXISTS match_winning_patterns(vector, int, text, int);
CREATE OR REPLACE FUNCTION match_winning_patterns(
  query_embedding vector,
  match_count int DEFAULT 5,
  outcome_filter text DEFAULT NULL,
  min_importance int DEFAULT 7
)
RETURNS TABLE (
  id uuid,
  situation text,
  pattern text,
  closing_action text,
  human_type_label text,
  outcome_type text,
  notes text,
  win_rate numeric,
  importance int,
  customer_intent text,
  staff_reply_intent text,
  similarity double precision
)
LANGUAGE sql STABLE AS $func$
  SELECT
    wp.id,
    wp.situation,
    wp.pattern,
    wp.closing_action,
    wp.human_type_label,
    wp.outcome_type,
    wp.notes,
    wp.win_rate,
    wp.importance,
    wp.customer_intent,
    wp.staff_reply_intent,
    (1 - (wp.embedding <=> query_embedding))::float AS similarity
  FROM winning_patterns wp
  WHERE wp.embedding IS NOT NULL
    AND wp.importance >= min_importance
    AND (outcome_filter IS NULL OR wp.outcome_type = outcome_filter)
  ORDER BY wp.embedding <=> query_embedding
  LIMIT match_count;
$func$;

-- スキーマキャッシュ再読込（新カラム追加後に必須・末尾で再実行）
SELECT pg_notify('pgrst', 'reload schema');

`.trim();

export const maxDuration = 300;

// GET: スキーマSQLを返す（POSTと同じ CRON_SECRET 認証必須 — 無認証でのスキーマ情報開示を防止）
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ sql: SQL });
}

// SQLをステートメント単位に分割する（ドル引用符 $$...$$ / $func$...$func$ 内のセミコロンでは分割しない）
// ※単純な split(";") だと関数定義本体が破壊されるため必須
function splitSql(sql: string): string[] {
  const stmts: string[] = [];
  let buf = "";
  let inDollar = false;
  for (const line of sql.split("\n")) {
    // $$の出現数が奇数なら引用符ブロックの開始/終了
    const dollarCount = (line.match(/\$\$|\$func\$/g) || []).length;
    if (dollarCount % 2 === 1) inDollar = !inDollar;
    buf += line + "\n";
    if (!inDollar && /;\s*$/.test(line.trimEnd())) {
      if (buf.trim()) stmts.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) stmts.push(buf.trim());
  return stmts;
}

// POST: 実際にマイグレーションを実行（デプロイ後に一度叩く）
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = (req.headers as Headers).get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase } = await import("@/app/lib/supabase");
  const statements = splitSql(SQL);
  const errors: string[] = [];
  for (const stmt of statements) {
    try {
      const { error } = await supabase.rpc("exec_sql", { sql: stmt.endsWith(";") ? stmt : stmt + ";" });
      if (error) errors.push(error.message);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  // PostgREST スキーマキャッシュ再読込（新カラム追加後に必須）。
  // SQL末尾の pg_notify に加えてここでも明示実行する（途中の statement 分割不具合等で
  // 末尾まで到達しなかった場合の保険。失敗しても migration 自体は成功として扱う）
  try {
    await supabase.rpc("exec_sql", { sql: "SELECT pg_notify('pgrst', 'reload schema');" });
  } catch (e) {
    console.warn("[migrate-schema] pgrst reload notify failed:", e instanceof Error ? e.message : String(e));
  }
  return NextResponse.json({ ok: errors.length === 0, errors });
}
