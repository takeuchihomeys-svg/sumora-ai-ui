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
  created_at TIMESTAMPTZ DEFAULT NOW()
);
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
  WHERE ae.conversation_state = ANY(filter_states) AND ae.embedding IS NOT NULL
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

-- ── PostgREST スキーマキャッシュ再読込（必ず最後に実行する）──
-- 新カラム追加後に PostgREST のスキーマキャッシュが古いままだと、
-- 以降の INSERT/SELECT が「column does not exist」で全滅する
-- （2026-07: is_full_rewrite カラムで save-reply-example が207回連続失敗した事故の恒久対策）。
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
