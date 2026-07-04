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
CREATE INDEX IF NOT EXISTS ai_reply_knowledge_embedding_idx ON ai_reply_knowledge USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
CREATE OR REPLACE FUNCTION match_reply_knowledge(query_embedding vector, match_count integer, min_importance integer DEFAULT 7)
RETURNS TABLE(id uuid, title text, content text, category text, conversation_state text, importance integer, similarity float)
LANGUAGE sql STABLE AS $$
  SELECT ak.id, ak.title, ak.content, ak.category, ak.conversation_state, ak.importance,
    (1 - (ak.embedding <=> query_embedding))::float AS similarity
  FROM ai_reply_knowledge ak
  WHERE ak.embedding IS NOT NULL AND ak.importance >= min_importance
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

-- LX-4: 予測アクション追跡カラム
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS suggested_action TEXT DEFAULT NULL;

-- P1: AIX経由テンプレのuse_count計測（どのテンプレIDが使われたか記録）
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS template_id UUID DEFAULT NULL;

-- P4: AIX送信メッセージの厳密特定（LINE message id + 送信時刻）
-- auto-template-candidates が ±10分ヒューリスティックではなく sent_at ベースの厳密マッチを行える
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS line_message_id TEXT DEFAULT NULL;
ALTER TABLE aix_usage_logs ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE action_pattern_logs ADD COLUMN IF NOT EXISTS predicted_action TEXT DEFAULT NULL;

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
ALTER TABLE aix_action_attribution DISABLE ROW LEVEL SECURITY
`.trim();

export async function GET() {
  return NextResponse.json({ sql: SQL });
}

// POST: 実際にマイグレーションを実行（デプロイ後に一度叩く）
export async function POST() {
  const { supabase } = await import("@/app/lib/supabase");
  const statements = SQL.split(";").map(s => s.trim()).filter(Boolean);
  const errors: string[] = [];
  for (const stmt of statements) {
    try {
      const { error } = await supabase.rpc("exec_sql", { sql: stmt + ";" });
      if (error) errors.push(error.message);
    } catch { /* ignore */ }
  }
  return NextResponse.json({ ok: true, errors });
}
