-- scripts/staff-todo-marks-migration.sql
-- 【やることリスト】のグループの✅（2026-10-21 竹内さんの決定 f87ccb7e G3「グループの✅も済みに」）
-- 本番に流す SQL。作成の部分は app/api/migrate-schema/route.ts の「やることリストのグループの✅」の節に同じ文で入っている（CLAUDE.md 絶対ルール4）。
--   ⚠ JS のテンプレート文字列にも貼るので、バックスラッシュ・バッククォート・「ドル記号＋波括弧」を使わない
--
-- 1行＝一覧の1行（item_key＝aix:<aix_action_items.id>／promise:<calendar_events.id>／viewing:<viewing_history.id>／reply:<会話>:<発言の時刻>）を
-- スタッフがグループで「✅3」「〇〇さん 完了」と返して済みにした印。書くのは hanbancyo-webhook（app/lib/staff-todo-reply-server.ts）、
-- 読むのは一覧の組み立て（app/lib/staff-todo-list-server.ts）。表が無い間も一覧は動く（AIX 要対応・約束の行は元の行を閉じるので✅になる・
-- 返信・内覧の行の✅と、閉じた約束の✅の時刻だけが残らない）
CREATE TABLE IF NOT EXISTS staff_todo_marks (
  id BIGSERIAL PRIMARY KEY,
  item_key TEXT NOT NULL UNIQUE,
  conversation_id TEXT,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  marked_by TEXT,
  via TEXT NOT NULL DEFAULT 'group_reply',
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_staff_todo_marks_marked_at ON staff_todo_marks(marked_at DESC);
ALTER TABLE staff_todo_marks DISABLE ROW LEVEL SECURITY;

-- ════════════════════════════════════════════════════════════════════
-- 流した後の確かめ（読むだけ）
-- ════════════════════════════════════════════════════════════════════
-- SELECT count(*) FROM staff_todo_marks;
-- 外す: DROP TABLE IF EXISTS staff_todo_marks;（一覧はグループの✅を読まなくなるだけ）
