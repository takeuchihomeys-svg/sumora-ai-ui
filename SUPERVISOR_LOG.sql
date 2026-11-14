-- 2026-11-14 学習の統括の判断を1回ごとに1行残す（竹内さん承認済み）
-- ⚠ 数と判断だけ。入力した中身・お客様の名前・電話・住所は入れません。
CREATE TABLE IF NOT EXISTS learn_supervisor_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scope TEXT NOT NULL DEFAULT 'all',
  verdict TEXT NOT NULL,
  headline TEXT,
  coverage INTEGER NOT NULL DEFAULT 0,
  weak_n INTEGER NOT NULL DEFAULT 0,
  next_n INTEGER NOT NULL DEFAULT 0,
  points_n INTEGER NOT NULL DEFAULT 0,
  opens_n INTEGER NOT NULL DEFAULT 0,
  screens_n INTEGER NOT NULL DEFAULT 0,
  sequence_n INTEGER NOT NULL DEFAULT 0,
  with_ops INTEGER NOT NULL DEFAULT 0,
  guessed_opens INTEGER NOT NULL DEFAULT 0,
  rows INTEGER NOT NULL DEFAULT 0,
  delta JSONB,
  actions JSONB,
  meeting JSONB,
  block TEXT,
  bundle_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_learn_supervisor_scope ON learn_supervisor_log(scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_learn_supervisor_created ON learn_supervisor_log(created_at DESC);

ALTER TABLE learn_supervisor_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE learn_supervisor_log IS '学習の統括の判断（結論・材料の揃い・弱い所・次にやる事・打ち合わせの内容）を1回ごとに1行。数と判断だけ。2026-11-14 竹内さん承認';

-- スキーマのキャッシュを更新（PostgREST がすぐ気づくように）
NOTIFY pgrst, 'reload schema';
