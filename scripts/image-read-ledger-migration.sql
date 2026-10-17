-- scripts/image-read-ledger-migration.sql — 資料の画像の読みの台帳（設計のみ・竹内さんの OK まで作らない）
-- 2026-10-17 ②: 今は台帳を aix_generate_log.property_details.ledger（既にある JSONB 列）と処理の中の覚えに置いている。
--   AIX【物件オススメ】以外（スタッフが手で送った画像・物件ピックアップ）も同じ台帳を使う・会話をまたいで指紋で使い回すにはこの表が要る。
--   表ができたら app/lib/image-read-ledger.ts の findStoredLedger / 保存に表を足す（IMAGE_READ_LEDGER_TABLE=on）。
CREATE TABLE IF NOT EXISTS image_read_ledger (
  content_hash TEXT PRIMARY KEY,          -- 画像の中身の SHA-256 の先頭32字（URL は再アップロードで変わる・設計知見 671821e3）
  kind TEXT NOT NULL,                     -- property / estimate / document / other
  transcript TEXT,                        -- 書き写し（繰り返しを切った物・物件の資料だけ）
  items JSONB DEFAULT '[]',               -- 物件名・号室・家賃…（PROPERTY_IMAGE_PROMPT の形）
  lines JSONB DEFAULT '[]',               -- 条件の行（image_details.lines と同じ形）
  facts JSONB,                            -- 駅・管理費・㎡・帖・所在地・間取り図の洗面（recommend-fact-guard.parseLedgerFacts）
  model TEXT,
  truncated BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS image_read_ledger_urls (
  image_url TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL REFERENCES image_read_ledger(content_hash) ON DELETE CASCADE,
  conversation_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_image_read_ledger_urls_hash ON image_read_ledger_urls(content_hash);
ALTER TABLE image_read_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE image_read_ledger_urls ENABLE ROW LEVEL SECURITY;
-- 方針なし＝service role だけが読み書き（本人確認書類は入れない: 台帳は kind=property 以外の本文を持たない）
