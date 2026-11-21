-- 2026-11-21 作業員N（台帳 #472・#473）の DDL を戻す。表の中身（竹内さんの指摘の帳面・毎日の質の数）も消えるので、戻す前に必要なら書き出す:
--   COPY (SELECT * FROM owner_pointers) TO STDOUT WITH CSV HEADER;
DROP TABLE IF EXISTS owner_pointer_events;
DROP TABLE IF EXISTS owner_pointers;
DROP TABLE IF EXISTS quality_daily;
ALTER TABLE work_item_events DROP CONSTRAINT IF EXISTS work_item_events_kind_chk;
ALTER TABLE work_item_events DROP COLUMN IF EXISTS kind;
ALTER TABLE work_items DROP COLUMN IF EXISTS owner_question_uuid;
SELECT pg_notify('pgrst', 'reload schema');
