/**
 * 写真から欄の種類を読んで `shot_learn` に書き戻す（2026-11-14 竹内さん）
 *
 *   竹内さん「弱い部分は学習データから写真で必要な部分読み取ったら学習できるのでは」
 *
 *   ⚠ 指示文（`SHOT_LEARN_PROMPT`）と読み取り（`parseShotLearn`）は作ってあったのに、
 *     **呼ぶ所が1か所も無かった**（実測 0箇所）。だから `shot_learn` は全件 0 だった。
 *   → 写真（Storage の JPEG）を Vision で読んで書き戻す。
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/shot-learn.ts --dry-run --limit=2
 *   npx tsx --env-file=.env.local scripts/shot-learn.ts --limit=20
 *   npx tsx --env-file=.env.local scripts/shot-learn.ts --site=realpro --days=7 --limit=30
 *
 * ⚠ お金がかかる（1枚ごと）。**dry-run で中身を確かめてから**本番で書く。
 * ⚠ 読むのは欄の種類・名前・画面の種類だけ（入力された中身は読ませない）。
 */
import { learnFromWeakShots, findShotsToLearn, shotLearnMax } from "../app/lib/shot-learn-server";

const args = process.argv.slice(2);
const argOf = (k: string, d: string) => (args.find((a) => a.startsWith(`--${k}=`)) || "").replace(`--${k}=`, "") || d;
const dryRun = args.includes("--dry-run");
const site = argOf("site", "all");
const days = Number(argOf("days", "7"));
const limit = Number(argOf("limit", String(shotLearnMax())));

void (async () => {
  console.log(`写真から学ぶ: site=${site} days=${days} limit=${limit}${dryRun ? "（dry-run＝書かない）" : ""}`);
  const targets = await findShotsToLearn({ site, days, limit });
  console.log(`まだ読んでいない写真: ${targets.length}件（読むのは ${Math.min(limit, targets.length)}件まで）`);
  if (!targets.length) { console.log("読む物がありません（全部読み済み／写真なし）"); return; }

  const r = await learnFromWeakShots({ site, days, limit, dryRun });
  console.log("\n結果:");
  console.log(`  試した: ${r.tried}枚`);
  console.log(`  読めた: ${r.learned}枚（欄 合計 ${r.fields}個）`);
  console.log(`  保存した: ${r.saved}枚${dryRun ? "（dry-run なので保存していません）" : ""}`);
  console.log(`  読めなかった: ${r.skipped}枚`);
  if (r.errors.length) {
    console.log("  エラー:");
    for (const e of r.errors.slice(0, 5)) console.log("    ・" + e);
  }
})();
