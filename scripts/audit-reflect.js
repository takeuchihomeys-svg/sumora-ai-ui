/**
 * 反映の点検: 「直したのに現場に届いていない」を機械で見つける
 *
 * 竹内さん「ちゃんと修正や改善あれば反映されるように。
 *   データベースに統括との連携をしっかりするようにする。学習して改善したら自動モード強化されるように」
 *
 * 見る所（5段）:
 *   ① リポジトリ（cursor-ext）の chrome-extension/* と、Chrome が読むフォルダが**同じか**
 *   ② 版（manifest）が上がっているか・両方で同じか
 *   ③ 直した印（目印）が Chrome 側のファイルに入っているか
 *   ④ main にサーバー側の変更が載っているか（拡張は cursor-ext 管理）
 *   ⑤ 学習の束が新しくなったら拡張が取り直す仕組みがあるか
 *
 * ⚠ これは「反映」だけを見る。動作の正しさは tests/chrome-extension/*.test.js が見る。
 *
 * 実行: node scripts/audit-reflect.js
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REPO = path.join(ROOT, "chrome-extension");
const CHROME = "C:\\Users\\Admin\\OneDrive\\Desktop\\chrome-extension";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};
const hash = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const read = (p) => fs.readFileSync(p, "utf8");

console.log("=== ① リポジトリと Chrome が読むフォルダが同じか");
{
  if (!fs.existsSync(CHROME)) {
    console.log("  ⚠ Chrome のフォルダが見つかりません:", CHROME);
  } else {
    const files = fs.readdirSync(REPO).filter((f) => fs.statSync(path.join(REPO, f)).isFile());
    const diff = [];
    for (const f of files) {
      const c = path.join(CHROME, f);
      if (!fs.existsSync(c)) { diff.push(`${f}（Chrome側に無い）`); continue; }
      if (hash(path.join(REPO, f)) !== hash(c)) diff.push(f);
    }
    t(`全 ${files.length} ファイルが一致`, diff.length === 0, diff.slice(0, 8));
    if (diff.length) {
      console.log("     → 反映する: Copy-Item -Path 'chrome-extension\\*' -Destination '" + CHROME + "' -Recurse -Force");
    }
  }
}

console.log("\n=== ② 版");
{
  const rv = JSON.parse(read(path.join(REPO, "manifest.json"))).version;
  console.log("  リポジトリ:", rv);
  if (fs.existsSync(path.join(CHROME, "manifest.json"))) {
    const cv = JSON.parse(read(path.join(CHROME, "manifest.json"))).version;
    console.log("  Chrome側  :", cv);
    t("版が同じ", rv === cv, { repo: rv, chrome: cv });
  }
}

console.log("\n=== ③ 直した印（目印）が Chrome 側に入っているか");
{
  if (!fs.existsSync(CHROME)) {
    console.log("  （Chrome のフォルダが無いので飛ばす）");
  } else {
    const ps = read(path.join(CHROME, "page-script.js"));
    const bg = read(path.join(CHROME, "background.js"));
    const hl = read(path.join(CHROME, "human-learn.js"));
    const lo = read(path.join(CHROME, "learn-order.js"));
    const marks = [
      ["地域モーダルの再計算（v2.7.24）", /hasModalWard = !!\(cond\.detail_ward\) \|\| \(hasCities && locationMode === "area"\)/.test(ps)],
      ["開く前に前の区を外す（v2.7.24）", ps.includes("_clearBeforeOpen")],
      ["区1つで検索へ（v2.7.24）", ps.includes("_areaAtLeastOneThenSearch")],
      ["検索の保険（v2.7.25）", ps.includes("__axSearchFallbackTimer")],
      ["search_look 二重防止（v2.7.24）", ps.includes("_nowMs - _lookAt < 6000")],
      ["_resetRest 関数宣言（v2.7.24）", /function _resetRest\(\)/.test(ps)],
      ["span/div を押せる判定（v2.7.25）", hl.includes("_clickable")],
      ["押した順番 order（v2.7.26）", /order: order\.slice\(0, 40\)/.test(hl)],
      ["一連の動きの鎖（v2.7.26）", lo.includes("mergeWithSequence")],
      ["一連の動きを置く（v2.7.26）", bg.includes("axlx_learn_seq")],
      ["モード別を置く（v2.7.26）", bg.includes("axlx_learn_next_mode")],
      ["1時間ごとに版を確かめる（v2.7.28）", bg.includes("_LEARN_CHECK_MS")],
    ];
    for (const [name, ok] of marks) t(name, ok);
  }
}

console.log("\n=== ④ main に載っているか（サーバー側）");
{
  try {
    const log = execFileSync("git", ["log", "main", "--oneline", "-1"], { cwd: ROOT, encoding: "utf8" }).trim();
    console.log("  main の最新:", log);
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "main"], { cwd: ROOT, encoding: "utf8" });
    for (const f of [
      "app/lib/human-learn-brain.ts",
      "app/api/human-learn-profile/route.ts",
      "app/api/cron/human-learn-brain/route.ts",
      "app/api/cron/morning-report/route.ts",
      "app/lib/shot-learn.ts",
    ]) {
      t(`main に ${f}`, files.includes(f));
    }
  } catch (e) {
    console.log("  ⚠ git を読めません:", e instanceof Error ? e.message : String(e));
  }
}

console.log("\n=== ⑤ 学習が新しくなったら取り直す仕組み");
{
  const bg = read(path.join(REPO, "background.js"));
  t("版を見に行く間隔を持つ", bg.includes("_LEARN_CHECK_MS"));
  t("1時間ごとに見る", /setInterval\(function \(\) \{[\s\S]{0,160}_refreshLearnedBundle\(false\)/.test(bg));
  t("版が同じなら取りに行かない", bg.includes('skipped: "same_version"'));
  t("版を保存する", bg.includes("axlx_learn_ver"));
  t("24時間固定ではない", !bg.includes("24 * 3600 * 1000"));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) {
  console.log("\n未反映の物があります。上の ✗ を直してください。");
  process.exit(1);
}
console.log("\n反映はすべて通っています。");
