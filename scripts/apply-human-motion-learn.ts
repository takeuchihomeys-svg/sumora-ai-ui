// 人の動きの学習（2026-11-11 竹内さん「データベース等にはいっているのか」→「新しい表を作る」OK）の本番DB: human_motion_learn。
// migrate-schema/route.ts と同じ DDL（memory/ddl_human_motion_learn.sql と同文）。
// 実行: npx tsx --env-file=.env.local scripts/apply-human-motion-learn.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `CREATE TABLE IF NOT EXISTS human_motion_learn (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  install_id TEXT,
  device_label TEXT,
  site TEXT,
  mode TEXT,
  ext_version TEXT,
  session_at TIMESTAMPTZ,
  ops INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 1,
  gap_ms INTEGER,
  moves_n INTEGER NOT NULL DEFAULT 0,
  move_speed_px_s INTEGER,
  move_curve NUMERIC(4,2),
  move_ms INTEGER,
  move_dist INTEGER,
  drag_n INTEGER NOT NULL DEFAULT 0,
  move_shapes JSONB,
  points_n INTEGER NOT NULL DEFAULT 0,
  point_x NUMERIC(4,2),
  point_y NUMERIC(4,2),
  point_fields JSONB,
  scrolls_n INTEGER NOT NULL DEFAULT 0,
  scroll_dy INTEGER,
  scroll_down INTEGER NOT NULL DEFAULT 0,
  scroll_up INTEGER NOT NULL DEFAULT 0,
  scroll_y NUMERIC(4,2),
  scroll_ys JSONB,
  kinds JSONB,
  fields TEXT[],
  field_order TEXT[],
  shot_taken BOOLEAN NOT NULL DEFAULT false,
  shot_key TEXT,
  shot_w INTEGER,
  shot_h INTEGER
);`,
  // 2026-11-12 竹内さん「データベースに画像入るようにしたらよいのでは」: Storage に置けなかった時の受け皿
  `ALTER TABLE human_motion_learn ADD COLUMN IF NOT EXISTS shot_b64 TEXT;`,
  `ALTER TABLE human_motion_learn ADD COLUMN IF NOT EXISTS shot_in_db BOOLEAN NOT NULL DEFAULT false;`,
  `CREATE INDEX IF NOT EXISTS idx_human_motion_created ON human_motion_learn(created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_human_motion_install ON human_motion_learn(install_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_human_motion_site ON human_motion_learn(site, mode, created_at DESC);`,
  // 2026-10-21 RLS の決まり: サーバーだけの表は RLS を入れたまま（DISABLE しない）。既定で RLS 有効・ポリシー無し＝サービスロール以外は触れない
  `ALTER TABLE human_motion_learn ENABLE ROW LEVEL SECURITY;`,
  `COMMENT ON TABLE human_motion_learn IS '通常・スタッフモードで人がどう動いたか（速さ・曲がり・押した位置・スクロール）。入力した中身・名前・電話は入れない。2026-11-11 竹内さん承認';`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

(async () => {
  let ng = 0;
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    if (error) ng++;
    console.log(error ? `NG ${error.message}` : "OK", sql.replace(/\s+/g, " ").slice(0, 90));
  }
  await new Promise((r) => setTimeout(r, 2000));
  const a = await sb.from("human_motion_learn").select("id, created_at, move_speed_px_s, point_x, shot_key").limit(1);
  console.log("select human_motion_learn:", a.error ? `NG ${a.error.message}` : `OK（行 ${a.data ? a.data.length : 0}）`);
  console.log(ng === 0 ? "全部 OK" : `NG ${ng} 件`);
})();
