-- scripts/kb-p0-tree-1107-rollback.sql — 2026-11-07 P0 の木（竹内さん「親5本の木にする」）を1回で戻す SQL
--   親 P0 の5本（ca55d42b・9eb6aa9c・2e164f41・575a7cd5・8805bd74）はそのまま。下げた21行を下げる前の段・親・札に戻す。
--   付け替えの中身は scripts/kb-p0-tree-1107.sql
BEGIN;
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{分析強化の原則,汎用,ブレイン診断,場面の整理,line-reply,AIX,絶対・最優先,場面:その他}'::text[] WHERE id='3300d3dc-44f9-4284-8eb9-c380ccd735e1';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{絶対・最優先,AIX,出口の決定論,line-reply,監査,場面:その他}'::text[] WHERE id='64697760-cf85-4135-a47a-1247568d2ca5';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{絶対・最優先,AIX,ブレイン,分析強化の原則,場面:その他}'::text[] WHERE id='4b744a33-b2d5-4345-bb10-ea1d2228fa3a';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{絶対・最優先,日本語,漢字,読み取り,物件名,汎用}'::text[] WHERE id='89bc2c3e-be0b-46e5-bb68-77a06c10b406';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{API費用,試験,ブレイン,節約,質,絶対・最優先}'::text[] WHERE id='4c91ffd9-6148-4673-bc7c-b326abce955a';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{絶対・最優先,ブレイン,DeepSeek,費用,質}'::text[] WHERE id='c0884407-95e6-429f-a067-a11ef69ac23c';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{絶対・最優先,ブレイン,設計,質,判断}'::text[] WHERE id='87456221-6bbf-42c9-bd5d-735665f22e0b';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{絶対・最優先,ブレイン,改善,試験,質}'::text[] WHERE id='5be49dda-28be-4a28-a01b-6290df307c4e';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{絶対・最優先,ブレイン,自動化,費用,改善}'::text[] WHERE id='eb783bc5-d595-400e-a3b5-12b203d4f4f5';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{絶対・最優先,竹内さんの決定,書く役,文体,従業員}'::text[] WHERE id='8e0d6f80-90cc-49c2-acaf-f67a17685049';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{絶対・最優先,竹内さんの決定,セキュリティ,RLS,個人情報}'::text[] WHERE id='5a831bcb-f3f4-40b5-a54d-394889d6be44';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{竹内さんの決定,RAG,ブレイン,API費用,材料,絶対・最優先}'::text[] WHERE id='1bf03f2c-2af6-46fa-b4a9-6c711e7cc46b';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{竹内さんの決定,竹内基準,文,絶対・最優先,採点,構成}'::text[] WHERE id='04ca13be-c80e-42e9-b282-b8a8717a6061';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{竹内さんの決定,分析強化の原則,汎用,つなぎ,絶対・最優先,統括}'::text[] WHERE id='4b0d868e-80d1-4e9a-b058-5b11450922a3';
UPDATE system_design_thinking SET priority=0, parent='4b0d868e-80d1-4e9a-b058-5b11450922a3'::uuid, parent_by='竹内さんの指示 11/04', parent_at='2026-11-03 16:04:39.347953+00'::timestamptz, tags='{竹内さんの決定,統括,ブレイン,設計,場面:初期費用,場面:内覧,絶対・最優先}'::text[] WHERE id='910a3a29-081f-41b3-af27-2f5197800b19';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{竹内さんの決定,統括,試験,費用,絶対・最優先}'::text[] WHERE id='2acd77de-f614-4d05-a735-dd28f36fe86c';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{竹内さんの決定,分析強化の原則,改善のサイクル,弱い所,試験,絶対・最優先}'::text[] WHERE id='a6f7fe3a-cc60-4dd1-bf5c-8e74ccc53ff9';
UPDATE system_design_thinking SET priority=0, parent='4c91ffd9-6148-4673-bc7c-b326abce955a'::uuid, parent_by='kb-insert:deepseek:0.80', parent_at='2026-11-07 00:07:27.617+00'::timestamptz, tags='{竹内さんの決定,分析強化の原則,試験,RAG,費用,絶対・最優先}'::text[] WHERE id='7b5ef932-0e70-4bea-ab04-b02b2144c6dc';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{竹内さんの決定,分析強化の原則,統括の芯,ブレイン,連携,絶対・最優先}'::text[] WHERE id='184f7f89-c8bd-4993-9f4a-437bf72c37da';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{竹内さんの決定,統括の芯,分析強化の原則,ブレイン,連携,絶対・最優先}'::text[] WHERE id='6f53ace4-65b4-4135-a945-dbdce91e3268';
UPDATE system_design_thinking SET priority=0, parent=NULL, parent_by=NULL, parent_at=NULL, tags='{竹内さんの決定,分析強化の原則,弱い所,改善のサイクル,ブレイン診断,絶対・最優先}'::text[] WHERE id='a6c3cb6e-109e-4bcc-9f1e-73bf02d9c8b7';
COMMIT;
