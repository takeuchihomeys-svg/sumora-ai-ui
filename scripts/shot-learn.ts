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
 *   npx tsx --env-file=.env.local scripts/shot-learn.ts --mode=normal --from=2026-11-15T09:32:00Z --to=2026-11-15T09:34:00Z --order=time --fine
 *
 * ⚠ お金がかかる（1枚 約0.17円・実測）。**dry-run で中身を確かめてから**本番で書く。
 * ⚠ 読むのは欄の種類・名前・画面の種類・領域だけ（入力された中身は読ませない）。
 * ⚠ 1枚 10〜50秒（推論モデル）。`--conc` で並列にする（既定4・最大6）。
 *
 * ★ 2026-11-15 竹内さん「反映させる」:
 *   学習の後に**束を自動で作り直す**（手で `--apply` しなくてよい）。
 *   止めたい時は `--no-refresh`。
 *
 * ★ 2026-11-15 竹内さん「今通常モードで録画しているまりあさんの画像から位置を学習」:
 *   `--from` / `--to` で時刻窓。
 *
 * ★ 2026-11-15 竹内さん「画像も順番で時間で学習すればより強化」「細かく強化」「連続録画で」:
 *   `--order=time` = 連続録画の時間順 / `--fine` = 同じ画面も短間隔で多めに取る（位置の票を固める）。
 */
import { learnFromWeakShots, findShotsToLearn, shotLearnMax } from "../app/lib/shot-learn-server";

const args = process.argv.slice(2);
const argOf = (k: string, d: string) => (args.find((a) => a.startsWith(`--${k}=`)) || "").replace(`--${k}=`, "") || d;
const dryRun = args.includes("--dry-run");
const planOnly = args.includes("--plan");
const noRefresh = args.includes("--no-refresh");
const fine = args.includes("--fine");
/** ★ 2026-11-18: 読んだ写真のうち場面の印（scene）が無い物だけ読み直す（場面別の位置に使う） */
const onlyNoScene = args.includes("--only-no-scene");
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
const from = argOf("from", "") || null;
const to = argOf("to", "") || null;
/**
 * ★ 2026-11-15「最新で録画」「通常から改善」: `--order=newest` を落とさない。
 *   旧: time 以外は全部 size に潰していた → newest が効かなかった。
 */
const orderRaw = argOf("order", fine || from ? "time" : "size");
const order = (
  orderRaw === "time" || orderRaw === "newest" || orderRaw === "size" || orderRaw === "sequence"
    ? orderRaw
    : "size"
) as "size" | "time" | "newest" | "sequence";
const runId = argOf("run", "") || null;
const focusRaw = argOf("focus", "");
const focusFields = focusRaw ? focusRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
const perSig = Math.max(1, Math.min(20, Number(argOf("per-sig", fine ? "12" : order === "time" || order === "newest" ? "8" : from ? "3" : "1")) || 1));
const strideMs = Math.max(0, Number(argOf("stride-ms", fine ? "800" : order === "time" || order === "newest" ? "1500" : "0")) || 0);

void (async () => {
  console.log(`写真から学ぶ: site=${site} mode=${mode} days=${days} limit=${limit} 並列${conc} order=${order}${runId ? ` run=${runId}` : ""}${focusFields?.length ? ` focus=${focusFields.join(",")}` : ""}${from ? ` from=${from}` : ""}${to ? ` to=${to}` : ""} perSig=${perSig} strideMs=${strideMs}${fine ? " fine" : ""}${dryRun ? "（dry-run＝書かない）" : ""}`);
  const targets = await findShotsToLearn({ site, mode, days, limit, from, to, perSig, order, strideMs, runId, focusFields, onlyNoScene });
  console.log(`まだ読んでいない写真: ${targets.length}件（読むのは ${Math.min(limit, targets.length)}件まで）`);
  if (!targets.length) { console.log("読む物がありません（全部読み済み／写真なし）"); return; }
  // 読む写真の大きさの内訳（⚠ 480px ばかりなら意味が無いので先に見せる）
  const sizes: Record<string, number> = {};
  for (const t of targets) { const k = String(Math.round((t as { shot_w?: number }).shot_w ?? 0) / 100 * 100); sizes[k] = (sizes[k] || 0) + 1; }
  console.log("  大きさ: " + Object.entries(sizes).sort((a, b) => Number(b[0]) - Number(a[0])).map(([k, c]) => `${k}px×${c}`).join(" / "));
  if ((order === "time" || order === "newest" || order === "sequence") && targets[0]?.created_at) {
    const first = String(targets[0].created_at).slice(11, 19);
    const last = String(targets[targets.length - 1]?.created_at ?? "").slice(11, 19);
    const label = order === "newest" ? "新しい順" : order === "sequence" ? "連続run順" : "時間順";
    console.log(`  ${label}: ${first} → ${last}`);
  }
  if (planOnly) {
    console.log("\n■ 計画（--plan＝Vision呼ばず対象コマのみ表示）");
    targets.forEach((t, i) => {
      const x = t as { created_at?: string; shot_w?: number; run_id?: string | null; context_note?: string | null };
      console.log(`  ${String(i + 1).padStart(2, " ")}. ${String(x.created_at || "").slice(11, 19)}  ${x.shot_w}px  run=${x.run_id || "-"}  ${String(x.context_note || "").slice(0, 90)}`);
    });
    return;
  }

  const started = Date.now();
  const r = await learnFromWeakShots({
    site, mode, days, limit, from, to, perSig, order, strideMs, runId, focusFields, onlyNoScene, dryRun, noRefresh, concurrency: conc,
    onProgress: (done, total, last) => {
      const pct = Math.round((done / Math.max(1, total)) * 100);
      if (dryRun || done % 4 === 0 || done === total) console.log(`  … ${done}/${total}（${pct}%）${Math.round((Date.now() - started) / 1000)}秒  ${last}`);
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
