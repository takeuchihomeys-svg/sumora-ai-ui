-- scripts/kb-p0-tree-1107.sql — 2026-11-07 竹内さん「親5本の木にする」（作業員1・統括役の頼み）
--   親 P0 の5本: A ca55d42b AIX と返信の分け方／B 9eb6aa9c 判断はブレイン基準／C 2e164f41 限りなく竹内さんに近づける／D 575a7cd5 統括の芯／E 8805bd74 弱い所はその場で直す
--   残り21行は親の子（P1）へ。RLS 5a831bcb は P1（親なし・作業の決定）。点検の記録 64697760 は P2（A の子）。
--   910a3a29（親 4b0d868e）と 7b5ef932（親 4c91ffd9）は今の親のまま（孫として D・B の下）。
--   下げた行は札「絶対・最優先」を外す（札があると週の整理が P0 に戻す）。理由と親は parent_by に残す。戻す: scripts/kb-p0-tree-1107-rollback.sql
BEGIN;
WITH m(id8, prio, par8) AS (VALUES
  ('3300d3dc', 1, 'ca55d42b'), ('4b744a33', 1, 'ca55d42b'), ('64697760', 2, 'ca55d42b'),
  ('87456221', 1, '9eb6aa9c'), ('c0884407', 1, '9eb6aa9c'), ('1bf03f2c', 1, '9eb6aa9c'), ('4c91ffd9', 1, '9eb6aa9c'), ('eb783bc5', 1, '9eb6aa9c'), ('7b5ef932', 1, NULL),
  ('8e0d6f80', 1, '2e164f41'), ('04ca13be', 1, '2e164f41'), ('2acd77de', 1, '2e164f41'), ('89bc2c3e', 1, '2e164f41'),
  ('4b0d868e', 1, '575a7cd5'), ('184f7f89', 1, '575a7cd5'), ('6f53ace4', 1, '575a7cd5'), ('910a3a29', 1, NULL),
  ('5be49dda', 1, '8805bd74'), ('a6f7fe3a', 1, '8805bd74'), ('a6c3cb6e', 1, '8805bd74'),
  ('5a831bcb', 1, NULL)
)
UPDATE system_design_thinking s SET
  priority = m.prio,
  parent = CASE WHEN m.par8 IS NULL THEN s.parent ELSE (SELECT p.id FROM system_design_thinking p WHERE left(p.id::text, 8) = m.par8) END,
  parent_by = 'P0の木 11/07 竹内さん: P0→P' || m.prio || COALESCE('（親 ' || m.par8 || '）', CASE WHEN s.parent IS NOT NULL THEN '（今の親のまま ' || left(s.parent::text, 8) || '）' ELSE '（親なし）' END),
  parent_at = now(),
  tags = array_remove(s.tags, '絶対・最優先'),
  updated_at = now()
FROM m WHERE left(s.id::text, 8) = m.id8 AND s.is_current AND s.priority = 0;
COMMIT;
