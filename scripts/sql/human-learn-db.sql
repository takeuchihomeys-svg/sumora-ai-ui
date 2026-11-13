// 2026-11-13 竹内さん「連携されてるから実行おねがい。データベースへのいこう」
// 「人の動きの学習」で使う表と列をDBに当てる（何度流しても同じ結果＝IF NOT EXISTS）
//
// 使い方（本番）:
//   1) 合言葉を Vercel の環境変数 ADMIN_SQL_SECRET（または SYNC_SECRET）に入れる
//   2) PowerShell から:
//      $s = "<合言葉>"
//      $body = @{ sql = (Get-Content scripts/sql/human-learn-db.sql -Raw) } | ConvertTo-Json
//      Invoke-WebRequest -Uri "https://sumora-ai-ui.vercel.app/api/admin/run-sql" -Method POST `
//        -Headers @{ Authorization = "Bearer $s" } -Body $body -ContentType "application/json"
//
// ⚠ 流す前に中身を見せてOKをもらう決まり。このファイルは「何を当てるか」の正本。

-- ① 写真の直前までの操作の並び（押す順番を学ぶ材料）
ALTER TABLE human_motion_learn ADD COLUMN IF NOT EXISTS shot_ops JSONB;
COMMENT ON COLUMN human_motion_learn.shot_ops IS '写真の直前までの操作の並び（時刻・種類・欄の名前）。入力した中身は入れない。2026-11-13 竹内さん承認';

-- ② 学習の束を置く表（拡張はこの1行を読むだけ）
CREATE TABLE IF NOT EXISTS human_learn_profile (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scope TEXT NOT NULL DEFAULT 'all',
  source_rows INTEGER NOT NULL DEFAULT 0,
  source_from TIMESTAMPTZ,
  source_to TIMESTAMPTZ,
  ext_version TEXT,
  bundle JSONB NOT NULL,
  lines TEXT[],
  read_at TIMESTAMPTZ,
  read_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_human_learn_profile_scope ON human_learn_profile(scope, created_at DESC);
ALTER TABLE human_learn_profile ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE human_learn_profile IS '人の動きの記録をまとめた学習の束（押す順番・押す場所・動きの速さ）。拡張はこれを読む。入力した中身は入れない。2026-11-13 竹内さん承認';

-- ③ 動作確認で入れたテスト行を消す（対象を明確に絞る）
DELETE FROM human_motion_learn WHERE install_id IN ('diag-col-probe', 'diag-shot-probe', 'diag-ops-probe');

-- ④ スキーマキャッシュの再読込（新しい列・表をすぐ見えるように）
SELECT pg_notify('pgrst', 'reload schema');
