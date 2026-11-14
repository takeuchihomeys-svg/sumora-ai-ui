// tests/chrome-extension/four-rules-v2772.test.js
// 実行: node tests/chrome-extension/four-rules-v2772.test.js
// 2026-11-14 竹内さん「所在地の部分も一気に押すのではなくて一つずつカーソル動かして押すようにする」
//   「同じ平米数の物件は賃料がいちばん低い部屋1部屋と」
//   「お客さんごとに送付済みの物件はおくらないようにすること」
//   「物件画面ないで検索したり送付済みで物件なければ次へ移動する部分もちゃんと学習を自動モードに反映する」
//   「ここの部分統括の部分改善おねがい／学習して大切な部分統括重要度上げてつぎに活かすようにする」
//
//   ★ 実測（自動モードの記録 54件）
//     所在地の区の間隔: 中央値 230ms・**300ms未満が 9/17**（128ms・136ms があった）＝一気押し
//     ⚠ 一方、**人の手本は全部ゆっくり**（336個の間隔で 300ms 未満が 0件・例 1967ms）。
//       ＝ 人がやる時は守れている。**自動モードが一気に押していた**のが問題。
//
//   → ① 区は `enqueueHumanClick`（カーソルを動かしてから押す・620〜1400ms）で1つずつ
//     ② 同じ㎡は最安1部屋（`_applyCheapestPerLayout`・実装済み）
//     ③ 送付済みは送らない（`sent-skip.js`・実装済み）
//     ④ **全部送付済みなら次のページへ**（`_autoNextPageThenRestart`・新規）
//     ⑤ ①〜④を統括の材料にする（`findWeakRules`）
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const dir = path.join(__dirname, "..", "..");
const ps = fs.readFileSync(path.join(dir, "chrome-extension", "page-script.js"), "utf8");
const bd = fs.readFileSync(path.join(dir, "chrome-extension", "bulk-dl.js"), "utf8");
const lf = fs.readFileSync(path.join(dir, "app", "lib", "learn-flow-steps.ts"), "utf8");
const brain = fs.readFileSync(path.join(dir, "app", "lib", "human-learn-brain.ts"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

console.log("■ ① 所在地の区を1つずつ押す（一気押しをやめる）");
{
  const i = ps.indexOf("function clickWardPrecise(texts)");
  const seg = ps.slice(i, i + 5000);
  ok("  ⚠ コードで探す側もキューに積む", /enqueueHumanClick\(c2 \|\| lb2, _clickEl, 620, 1400/.test(seg));
  ok("  ⚠ 文字で探す側もキューに積む", /enqueueHumanClick\(inp \|\| wardLabels\[i\], _clickEl, 620, 1400/.test(seg));
  ok("  ⚠ ループ内の同期クリックが残っていない", !/simulateClick\(lb2\); hitByCode/.test(seg));
  ok("  人が区を選ぶ速さ（620〜1400ms）", /620, 1400/.test(seg));
  ok("  ⚠ そろうまで待つ仕組みがある（確定前に確かめる）", /_verifyThenConfirm/.test(ps));
}

console.log("\n■ ② 同じ平米数は賃料が一番安い1部屋（実装済みを固定）");
{
  ok("  _applyCheapestPerLayout がある", /_applyCheapestPerLayout/.test(bd));
  ok("  ⚠ 外すのは印を付けた物だけ（全件を空にしない）", /__axCheapestSkip/.test(bd));
  ok("  ⚠ 候補(cand)を対象にする（チェック状態で絞らない）", /_applyCheapestPerLayout\(state, cand\)/.test(bd));
}

console.log("\n■ ③ 送付済みは送らない（実装済みを固定）");
{
  ok("  sent-skip.js を読み込んでいる", /import "\.\/sent-skip\.js"/.test(fs.readFileSync(path.join(dir, "chrome-extension", "background.js"), "utf8")));
  ok("  ⚠ 送った行は押さない", /_onePdfSent\[url\]/.test(bd));
}

console.log("\n■ ④ 全部送付済みなら次のページへ進む（新規）");
{
  ok("  ⚠ 飛ばした数を数えている", /_autoPdfRun\.skipped = \(Number\(_autoPdfRun\.skipped\) \|\| 0\) \+ 1/.test(bd));
  ok("  ⚠ 0件送信＋1件以上飛ばしたら次ページへ", /var allSkipped = \(n === 0 && skipped > 0\)/.test(bd));
  ok("  _autoNextPageThenRestart がある", /function _autoNextPageThenRestart/.test(bd));
  ok("  ⚠ 次ページが無ければ終わる（無限にめくらない）", /if \(!btn\) \{/.test(bd));
  ok("  ⚠ 進むのは3回まで", /_autoNextPageTries >= 3/.test(bd));
  ok("  ⚠ 新しい検索で回数を0に戻す", /_autoNextPageTries = 0/.test(bd));
  ok("  ⚠ 進んだ後は結果を見る間を入れる", /_startAutoPressAfterLook/.test(bd));
  ok("  bulk-dl に無い関数を使っていない（enqueueHumanClick）", !/^\s*enqueueHumanClick\(btn/m.test(bd));
}

console.log("\n■ ⑤ 統括の材料にする（findWeakRules）");
{
  ok("  findWeakRules がある", /export function findWeakRules/.test(lf));
  ok("  ⚠ 一気押しを判定する", /area_clicked_too_fast/.test(lf));
  ok("  ⚠ 同じ㎡の絞り忘れを判定する", /same_sqm_not_narrowed/.test(lf));
  ok("  徒歩の判定と一緒に返す", /const rules = findWeakRules\(runs\)/.test(lf));
  ok("  ⚠ 重複して足さない", /if \(!out\.some\(\(x\) => x\.kind === r\.kind\)\) out\.push\(r\)/.test(lf));
  ok("  ⚠ 統括に時刻も渡す（間隔を見るため）", /flowsForWalk\.push\(s\.map\(\(x\) => \(\{ f: x\.f, t: x\.t \}\)\)\)/.test(brain));
}

console.log("\n■ ⑥ 実測: 人の手本は守れている（一気押しは自動モードだけ）");
{
  /**
   * ⚠ 実測（DB 400件）: 人の手本の区の間隔 336個で **300ms 未満が 0件**（例 1967ms）。
   *   一気押し（128ms・136ms）は**自動モード（aix）の記録**だった。
   *   `human-learn-brain` は `by:"human"` だけを手本にするので自動は除外される＝判定は正しい。
   */
  ok("  ⚠ 人が押した物だけを手本にする", /if \(hasBy && r\.by !== "human"\) continue/.test(brain));
}

console.log("\n■ ⑦ 構文");
{
  let ok1 = true, ok2 = true;
  try { execFileSync(process.execPath, ["--check", path.join(dir, "chrome-extension", "page-script.js")], { stdio: "pipe" }); } catch { ok1 = false; }
  try { execFileSync(process.execPath, ["--check", path.join(dir, "chrome-extension", "bulk-dl.js")], { stdio: "pipe" }); } catch { ok2 = false; }
  ok("  page-script.js の構文が通る", ok1);
  ok("  bulk-dl.js の構文が通る", ok2);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
