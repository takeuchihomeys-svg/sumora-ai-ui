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
`.trim();

export async function GET() {
  return NextResponse.json({ sql: SQL });
}
