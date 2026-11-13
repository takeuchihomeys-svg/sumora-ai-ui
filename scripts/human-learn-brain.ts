// 人の動きの記録をまとめて「学習の束」を作る（読むだけ→--apply で DB に書く）
//
// 2026-11-13 竹内さん「ちゃんと学習担当のブレインをつくってより効率的に学習できるようにする。
//   データベースを有効活用する」
//
// 実行:
//   npx tsx --env-file=.env.local scripts/human-learn-brain.ts             # 見るだけ（記録しない）
//   npx tsx --env-file=.env.local scripts/human-learn-brain.ts --apply     # human_learn_profile に書く
//   npx tsx --env-file=.env.local scripts/human-learn-brain.ts --days=7    # 期間を変える
//
// 本番の毎晩のまとめ: /api/cron/human-learn-brain（Vercel Cron・同じ app/lib/human-learn-brain.ts を使う）
import { createClient } from "@supabase/supabase-js";
import { buildHumanLearnBundle, compactBundle, type MotionRow } from "../app/lib/human-learn-brain";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
);

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? null;
const has = (k: string) => process.argv.includes(`--${k}`);

const SELECT = [
  "created_at", "site", "mode", "ext_version", "ops",
  "moves_n", "move_speed_px_s", "move_curve", "move_ms", "move_dist",
  "points_n", "point_x", "point_y", "point_fields",
  "scrolls_n", "scroll_dy", "kinds", "fields", "field_order", "shot_ops", "shot_learn",
].join(", ");

(async () => {
  const days = Math.min(Math.max(Number(arg("days") ?? 30) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: MotionRow[] = [];
  /**
   * 2026-11-13: `shot_ops` の列がまだ無い DB でも動くようにする（列を足す前は読めなかった）。
   *   列が無いと言われたら、その列だけ外して読み直す。
   */
  const fetchPage = async (cols: string, from: number, to: number) =>
    sb.from("human_motion_learn").select(cols)
      .gte("created_at", since).order("created_at", { ascending: false }).range(from, to);
  let cols = SELECT;
  for (let i = 0; i < 20_000; i += 1000) {
    let r = await fetchPage(cols, i, i + 999);
    if (r.error && /shot_ops/i.test(r.error.message) && cols.includes("shot_ops")) {
      cols = cols.replace(", shot_ops", "").replace(", shot_learn", "");
      console.log("（shot_ops 列がまだ無いので、押す場所と動きだけ学びます）");
      r = await fetchPage(cols, i, i + 999);
    }
    if (r.error) { console.error("読めない:", r.error.message); process.exit(1); }
    rows.push(...((r.data ?? []) as unknown as MotionRow[]));
    if (!r.data || r.data.length < 1000) break;
  }
  console.log(`■ 元にした記録: ${rows.length}件（直近${days}日）`);

  const all = compactBundle(buildHumanLearnBundle(rows));
  console.log("\n■ 学んだこと:");
  for (const line of all.lines) console.log("  " + line);

  console.log("\n■ 押す順番（上位10）:");
  Object.entries(all.next).slice(0, 10).forEach(([from, v]) => {
    console.log(`  「${from}」 → 「${v.next}」 (${v.n}/${v.total}回)`);
  });

  console.log("\n■ 押す場所（上位10）:");
  all.buttons.slice(0, 10).forEach((b) => {
    const p = all.points[b.name];
    console.log(`  ${b.name} … ${b.n}回・横${p ? Math.round(p.x * 100) : "?"}%・縦${p ? Math.round(p.y * 100) : "?"}%`);
  });

  if (has("apply")) {
    const { error } = await sb.from("human_learn_profile").insert({
      scope: "all",
      source_rows: all.source.rows,
      source_from: all.source.from,
      source_to: all.source.to,
      bundle: all,
      lines: all.lines,
    });
    console.log(error ? `\n■ 書けませんでした: ${error.message}` : "\n■ human_learn_profile に書きました（scope=all）");
  } else {
    console.log("\n（--apply を付けると human_learn_profile に書きます）");
  }
})();
