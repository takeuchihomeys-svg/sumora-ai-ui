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
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);
CREATE INDEX IF NOT EXISTS idx_templates_sort_order ON templates(sort_order);

ALTER TABLE templates DISABLE ROW LEVEL SECURITY;

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

-- 部屋の広さ（㎡以上）
ALTER TABLE property_customers ADD COLUMN IF NOT EXISTS floor_area_min INTEGER;

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
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  customer_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
ALTER TABLE line_tasks DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_line_tasks_conversation_status ON line_tasks(conversation_id, status);
ALTER PUBLICATION supabase_realtime ADD TABLE line_tasks
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
