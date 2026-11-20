-- 戻す SQL（2026-11-21 作業員G・#448）: AIX の記録から結んだ送った画像の行（source=aix_log:<種類>）を消す。
--   読み取りで照合した行（aix:<種類>・staff_image・vision 等）は消さない。backfill と送信時の結び（SENT_IMAGE_AIX_ATTRIBUTE）の両方が対象。
--   先に数を見る:
SELECT source, count(*) FROM sent_image_properties WHERE source LIKE 'aix_log:%' GROUP BY 1;
--   消す（統括役の判断で流す）:
-- DELETE FROM sent_image_properties WHERE source LIKE 'aix_log:%';
