-- scripts/cleanup-stale-line-tasks-2026-10-08.sql
-- 古い pending のやること（line_tasks）の片付け。**まだ本番に流していない**（竹内さんの確認の後に流す）。
--
-- 2026-10-08 竹内さんの決定「タスクは、ブレインの判断（AIX要対応）から作る形に一本化する」:
--   語（お客様の発言・スタッフの送信・画面）で作られたやることの残り。10/08 時点の pending 53件のうち 7日より前が 41件
--   （property_send 27・property_check 12・estimate_sheet 2。6月の自由文の頃の残りを含む）。
--   これが残ると: 台帳（action-ledger）が pending の物件出しを「こちらがピックアップを約束した（未履行）」と読み続ける・
--   画面の「やること:」帯・朝の報告の未完了タスクに出続ける。
--   7日以内の物（12件）は本物の約束の事があるので残す（ブレインの判断で取り下げる＝印 brain の物だけ。旧の物は手か次の AIX で閉じる）。
--
-- 手順: ①控えを取る ②片付ける ③数を確かめる。戻す時は ④。

-- ① 控え（同じ日に2回流しても重複しない）
CREATE TABLE IF NOT EXISTS line_tasks_cleanup_20261008 AS
  SELECT * FROM line_tasks WHERE false;
INSERT INTO line_tasks_cleanup_20261008
  SELECT t.* FROM line_tasks t
  WHERE t.status = 'pending'
    AND t.created_at < now() - interval '7 days'
    AND NOT EXISTS (SELECT 1 FROM line_tasks_cleanup_20261008 b WHERE b.id = t.id);

-- ② 片付け（cancelled・印 cleanup:2026-10-08）
UPDATE line_tasks t
SET status = 'cancelled',
    completed_at = now(),
    result_note = 'cleanup:2026-10-08'
WHERE t.id IN (SELECT id FROM line_tasks_cleanup_20261008)
  AND t.status = 'pending';

-- ③ 確かめる（控えの件数と片付けた件数が同じ・7日以内の pending は残っている）
SELECT
  (SELECT count(*) FROM line_tasks_cleanup_20261008)                                   AS backed_up,
  (SELECT count(*) FROM line_tasks WHERE result_note = 'cleanup:2026-10-08')             AS cancelled_now,
  (SELECT count(*) FROM line_tasks WHERE status = 'pending')                             AS still_pending;

-- ④ 戻し方（片付けた物を元の pending に戻す。後から同じ会話×種類の pending が出来ていたら一意索引に当たるので、その物は戻さない）
-- UPDATE line_tasks t
-- SET status = b.status, completed_at = b.completed_at, result_note = b.result_note
-- FROM line_tasks_cleanup_20261008 b
-- WHERE t.id = b.id
--   AND t.result_note = 'cleanup:2026-10-08'
--   AND NOT EXISTS (
--     SELECT 1 FROM line_tasks x
--     WHERE x.conversation_id = t.conversation_id AND x.task_type = t.task_type AND x.status = 'pending' AND x.id <> t.id
--   );
-- 控えの表を消す時: DROP TABLE line_tasks_cleanup_20261008;
