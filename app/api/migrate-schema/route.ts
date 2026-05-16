import { NextResponse } from "next/server";

const SQL = `
-- property_customers テーブル（物件出しツール用）
CREATE TABLE IF NOT EXISTS property_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name TEXT NOT NULL,
  line_user_id TEXT,
  phone TEXT,
  status TEXT DEFAULT 'first_reply',
  priority TEXT DEFAULT 'normal',
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
