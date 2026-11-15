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
 *   npx tsx --env-file=.env.local scripts/shot-learn.ts --days=1 --limit=200 --conc=5
 *
 * ⚠ お金がかかる（1枚 約0.17円・実測）。**dry-run で中身を確かめてから**本番で書く。
 * ⚠ 読むのは欄の種類・名前・画面の種類・領域だけ（入力された中身は読ませない）。
 * ⚠ 1枚 10〜50秒（推論モデル）。`--conc` で並列にする（既定4・最大6）。
 *
 * ★ 2026-11-15 竹内さん「反映させる」:
 *   学習の後に**束を自動で作り直す**（手で `--apply` しなくてよい）。
 *   止めたい時は `--no-refresh`。
 */
import { learnFromWeakShots, findShotsToLearn, shotLearnMax } from "../app/lib/shot-learn-server";

const args = process.argv.slice(2);
const argOf = (k: string, d: string) => (args.find((a) => a.startsWith(`--${k}=`)) || "").replace(`--${k}=`, "") || d;
const dryRun = args.includes("--dry-run");
const noRefresh = args.includes("--no-refresh");
const site = argOf("site", "all");
/**
 * ★ 2026-11-15 竹内さん「通常モードの写真から学習する」:
 *   **モードで絞れる**ようにする（`--mode=normal` / `--mode=aix`）。
 *   ⚠ 通常モードは**人の手本**（自動モードの手本にしない）。
 *     分けて学ぶ事で「人の動きだけ」を手本にできる。
 */
const mode = argOf("mode", "all");
const days = Number(argOf("days", "7"));
const limit = Number(argOf("limit", String(shotLearnMax())));
const conc = Math.max(1, Math.min(6, Number(argOf("conc", "4")) || 4));

void (async () => {
  console.log(`写真から学ぶ: site=${site} mode=${mode} days=${days} limit=${limit} 並列${conc}${dryRun ? "（dry-run＝書かない）" : ""}`);
  const targets = await findShotsToLearn({ site, mode, days, limit });
  console.log(`まだ読んでいない写真: ${targets.length}件（読むのは ${Math.min(limit, targets.length)}件まで）`);
  if (!targets.length) { console.log("読む物がありません（全部読み済み／写真なし）"); return; }
  // 読む写真の大きさの内訳（⚠ 480px ばかりなら意味が無いので先に見せる）
  const sizes: Record<string, number> = {};
  for (const t of targets) { const k = String(Math.round((t as { shot_w?: number }).shot_w ?? 0) / 100 * 100); sizes[k] = (sizes[k] || 0) + 1; }
  console.log("  大きさ: " + Object.entries(sizes).sort((a, b) => Number(b[0]) - Number(a[0])).map(([k, c]) => `${k}px×${c}`).join(" / "));

  const started = Date.now();
  const r = await learnFromWeakShots({
    site, days, limit, dryRun, noRefresh, concurrency: conc,
    onProgress: (done, total) => {
      const pct = Math.round((done / Math.max(1, total)) * 100);
      if (done % 5 === 0 || done === total) console.log(`  … ${done}/${total}（${pct}%）${Math.round((Date.now() - started) / 1000)}秒`);
    },
  });
  console.log("\n結果:");
  console.log(`  試した: ${r.tried}枚`);
  console.log(`  読めた: ${r.learned}枚（欄 合計 ${r.fields}個）`);
  console.log(`  保存した: ${r.saved}枚${dryRun ? "（dry-run なので保存していません）" : ""}`);
  console.log(`  読めなかった: ${r.skipped}枚`);
  console.log(`  時間: ${Math.round((Date.now() - started) / 1000)}秒`);
  if (r.recipe) console.log(`  読み方の成績: ${r.recipe}`);
  /**
   * ★ 2026-11-15「反映させる」: 学習の後に**束を自動で作り直す**。
   *   ⚠ これをしないと、学んだのに統括・拡張に届かない（実測で踏んだ）。
   */
  console.log(`  束の作り直し: ${r.refreshed ? "✅ した（統括・拡張に届く）" : dryRun ? "（dry-run なのでしない）" : "⚠ できなかった"}`);
  if (r.errors.length) {
    console.log("  エラー:");
    for (const e of r.errors.slice(0, 5)) console.log("    ・" + e);
  }
})();
