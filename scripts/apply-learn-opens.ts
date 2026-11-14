/**
 * human_motion_learn に opens / open_kinds を足す（2026-11-14 竹内さん承認）
 *
 *   「ボタンなのかプルダウンなのか、どこで展開されるのかも意識して学習して改善する」
 *   押したら**何が開いたか**（小窓 modal／選択肢 options／入力欄 form／結果 result）を欄ごとに残す。
 *   ⚠ 入れるのは**開いた物の種類と数**だけ（入力した中身・文字・お客様の情報は入れない）。
 *
 * 実行: npx tsx --env-file=.env.local scripts/apply-learn-opens.ts
 */
import { supabase as sb } from "../app/lib/supabase-server";

const STMTS: string[] = [
  `ALTER TABLE human_motion_learn ADD COLUMN IF NOT EXISTS opens JSONB;`,
  `ALTER TABLE human_motion_learn ADD COLUMN IF NOT EXISTS open_kinds JSONB;`,
  `COMMENT ON COLUMN human_motion_learn.opens IS '押したら何が開いたか（欄ごと: {opens:"modal",n:3}）。開いた物の種類だけ。2026-11-14 竹内さん承認';`,
  `COMMENT ON COLUMN human_motion_learn.open_kinds IS '開いた物の種類の内訳（{modal:3,options:5}）。2026-11-14 竹内さん承認';`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

void (async () => {
  let ng = 0;
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    if (error) ng++;
    console.log(error ? `NG ${error.message}` : "OK", sql.replace(/\s+/g, " ").slice(0, 96));
  }
  // スキーマキャッシュが更新されるのを少し待つ
  await new Promise((r) => setTimeout(r, 2500));
  const a = await sb.from("human_motion_learn").select("id, opens, open_kinds").limit(1);
  console.log("select opens/open_kinds:", a.error ? `NG ${a.error.message}` : `OK（行 ${a.data ? a.data.length : 0}）`);
  console.log(ng === 0 && !a.error ? "全部 OK" : `NG ${ng} 件`);
})();
