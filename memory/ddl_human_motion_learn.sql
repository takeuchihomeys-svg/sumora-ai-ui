-- ════════════════════════════════════════════════════════════════════════════
-- human_motion_learn（新規・2026-11-11 竹内さん承認）
--   通常モード・スタッフモードで**人が実際にどう動いたか**を覚える表。
--   「マウスの動かし方・ボタンのどこを押したか・画面の動かし方」を1回分ずつ残す。
--
--   ⚠ 入力した中身（文字・数字）は入れない（欄の名前・動き方・間だけ）。
--   ⚠ お客様の名前・電話・住所も入れない。
--
--   Supabase プロジェクト: wfwsmwxakhyxobytszoq（sumora-ai-ui）
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS human_motion_learn (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ⚠ 画面の写真の**中身（画像そのもの）はこの表に入れない**（1行が数百KBになり集計が重くなる）。
  --   写真は Storage に置き、この表には「撮った・どこに置いた」だけを持つ。

  -- どの PC・どのサイト・どのモードで覚えたか
  install_id TEXT,                                  -- 拡張の設置 ID（同じ PC を見分ける）
  device_label TEXT,                                -- 「竹内PC」等（分かる時だけ）
  site TEXT CHECK (site IS NULL OR site IN ('realpro', 'itandi', 'reins')),
  mode TEXT CHECK (mode IS NULL OR mode IN ('normal', 'staff')),
  ext_version TEXT,

  -- 覚えた回（1回＝1ページを離れるまで、または1分ごとの書き出し）
  session_at TIMESTAMPTZ,
  ops INTEGER NOT NULL DEFAULT 0,                   -- 操作の数（click/key/change/scroll）
  sessions INTEGER NOT NULL DEFAULT 1,              -- 何回分をまとめたか
  gap_ms INTEGER,                                   -- 操作と操作の間の中央値（ms）

  -- マウスの動かし方
  moves_n INTEGER NOT NULL DEFAULT 0,               -- 1回の移動を何回分覚えたか
  move_speed_px_s INTEGER,                          -- ふだんの速さ（px/秒）
  move_curve NUMERIC(4,2),                          -- 曲がり具合（1.00＝まっすぐ・大きいほど曲がる）
  move_ms INTEGER,                                  -- 1回の移動にかける時間（中央値）
  move_dist INTEGER,                                -- 1回の移動の距離（中央値・px）
  drag_n INTEGER NOT NULL DEFAULT 0,                -- 押しながら動かした回
  move_shapes JSONB,                                -- どう曲がったかの見本（最大6本・画面の％）

  -- ボタンのどこを押したか
  points_n INTEGER NOT NULL DEFAULT 0,
  point_x NUMERIC(4,2),                             -- ふだんは横のどこか（0＝左端・0.5＝真ん中）
  point_y NUMERIC(4,2),                             -- ふだんは縦のどこか（0＝上端・0.5＝真ん中）
  point_fields JSONB,                               -- 欄ごとの癖（{"検索":{n,x,y}, ...}）

  -- 画面の動かし方
  scrolls_n INTEGER NOT NULL DEFAULT 0,
  scroll_dy INTEGER,                                -- 1回の量（中央値・px）
  scroll_down INTEGER NOT NULL DEFAULT 0,
  scroll_up INTEGER NOT NULL DEFAULT 0,
  scroll_y NUMERIC(4,2),                            -- よく居るページ内の位置（0＝上・1＝下）
  scroll_ys JSONB,                                  -- どこまで送ってから押すかの見本（最大20個）

  -- 操作の種類の内訳（{"click":12,"key":3,...}）と欄の順
  kinds JSONB,
  fields TEXT[],                                    -- 触った欄の名前（重複なし・最大40）
  field_order TEXT[],                               -- 触った順（最大40）

  -- 画面の写真（任意）
  shot_taken BOOLEAN NOT NULL DEFAULT false,        -- この回に画面の写真を撮ったか
  shot_key TEXT,                                    -- 保管先のキー（Storage に入れた時の名前・中身は入れない）
  shot_w INTEGER,
  shot_h INTEGER
);

-- 見る時の索引（新しい順・PCごと・サイトごと）
CREATE INDEX IF NOT EXISTS idx_human_motion_created ON human_motion_learn(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_human_motion_install ON human_motion_learn(install_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_human_motion_site ON human_motion_learn(site, mode, created_at DESC);

COMMENT ON TABLE human_motion_learn IS
  '通常モード・スタッフモードで人がどう動いたか（マウスの速さ・曲がり・押した位置・スクロール）を1回分ずつ。入力した中身・名前・電話は入れない。2026-11-11 竹内さん承認';
COMMENT ON COLUMN human_motion_learn.move_shapes IS 'どう曲がったかの見本（画面の％の点・最大6本）。値ではなく軌跡の形だけ';
COMMENT ON COLUMN human_motion_learn.point_fields IS '欄ごとの押す位置の癖（要素の中の0〜1の割合）。入力した中身は持たない';
COMMENT ON COLUMN human_motion_learn.shot_key IS '画面の写真の保管先のキー（画像そのものはこの表に入れない＝Storage に置く）';
