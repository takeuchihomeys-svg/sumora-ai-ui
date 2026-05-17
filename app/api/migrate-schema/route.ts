import { NextResponse } from "next/server";

const SQL = `
-- conversations テーブル（LINEトーク一覧）
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  customer_name TEXT,
  status TEXT DEFAULT 'first_reply',
  line_user_id TEXT NOT NULL,
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

-- RLS無効化（ログインなしでアクセス可能にする）
ALTER TABLE property_customers DISABLE ROW LEVEL SECURITY;
`.trim();

export async function GET() {
  return NextResponse.json({ sql: SQL });
}
