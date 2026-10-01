-- scripts/line-watch-stage2-migration.sql
-- LINE の見張り 2段目（2026-10-01 竹内「見張りの2段目おこなう」・設計 line-watch-design.md §3.2・§8）
-- 本番に流す SQL。作成の部分は app/api/migrate-schema/route.ts の「LINE の見張り 2段目」の節に同じ文で入っている（CLAUDE.md 絶対ルール4）。
-- 1段目（scripts/line-watch-migration.sql）の表 line_watch_turns に列を足すだけ。トリガー・関数・設定の表は触らない。
--   ⚠ JS のテンプレート文字列にも貼るので、バックスラッシュ・バッククォート・「ドル記号＋波括弧」を使わない
--
-- 足す列:
--   judge_version            … 判定した規則の版（line-watch-judge.ts の JUDGE_VERSION。規則を変えたら翌晩に直近の番をやり直す目印）
--   verdict_review           … 画面の👍（agree＝判定が正しい）／✋（disagree＝判定が違う）。竹内さん・スタッフが物差しを直すための印
--   verdict_review_verdict   … ✋の時に「本当はこれ」の判定（same／same_meaning／partial／different／na）
--   verdict_review_rule      … 押した時に画面に出ていた判定（後で規則を変えても、何に対しての👍✋かが残る）
--   verdict_review_note      … 一言（任意・200字）
--   verdict_reviewed_at      … 押した時刻
-- 既にある列（1段目で作った・2段目の cron が書く）: staff_first_at・staff_texts・staff_aix・decision_id・verdict・verdict_detail・
--   draft_ready_before_staff・evaluated_at・scene_key・auto_review（3段目の自動送信の👍✋用・今は使わない）

ALTER TABLE line_watch_turns ADD COLUMN IF NOT EXISTS judge_version TEXT;
ALTER TABLE line_watch_turns ADD COLUMN IF NOT EXISTS verdict_review TEXT;
ALTER TABLE line_watch_turns ADD COLUMN IF NOT EXISTS verdict_review_verdict TEXT;
ALTER TABLE line_watch_turns ADD COLUMN IF NOT EXISTS verdict_review_rule TEXT;
ALTER TABLE line_watch_turns ADD COLUMN IF NOT EXISTS verdict_review_note TEXT;
ALTER TABLE line_watch_turns ADD COLUMN IF NOT EXISTS verdict_reviewed_at TIMESTAMPTZ;
-- 未判定の番を拾う索引（毎晩の cron）・場面ごとの集計の索引
CREATE INDEX IF NOT EXISTS idx_line_watch_turns_unevaluated ON line_watch_turns(customer_turn_at) WHERE evaluated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_line_watch_turns_scene ON line_watch_turns(scene_key, customer_turn_at DESC);

-- ════════════════════════════════════════════════════════════════════
-- 流した後の確かめ（読むだけ）
-- ════════════════════════════════════════════════════════════════════
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'line_watch_turns' AND column_name LIKE 'verdict%' OR column_name = 'judge_version';
-- 翌晩の cron の後:
-- SELECT scene_key, verdict, count(*) FROM line_watch_turns WHERE evaluated_at IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2;
-- SELECT cron_name, started_at, ok, left(result_json::text, 300) FROM cron_run_logs WHERE cron_name LIKE 'line-watch-%' ORDER BY started_at DESC LIMIT 4;

-- ════════════════════════════════════════════════════════════════════
-- 外し方（列ごと消す・判定と👍✋が消える）— 流す時はコメントを外す
--   ⚠ migrate-schema を次に流すと作り直されるので、外したままにする時は route.ts の該当の節も消す
-- ════════════════════════════════════════════════════════════════════
-- DROP INDEX IF EXISTS idx_line_watch_turns_unevaluated;
-- DROP INDEX IF EXISTS idx_line_watch_turns_scene;
-- ALTER TABLE line_watch_turns DROP COLUMN IF EXISTS judge_version, DROP COLUMN IF EXISTS verdict_review, DROP COLUMN IF EXISTS verdict_review_verdict,
--   DROP COLUMN IF EXISTS verdict_review_rule, DROP COLUMN IF EXISTS verdict_review_note, DROP COLUMN IF EXISTS verdict_reviewed_at;
