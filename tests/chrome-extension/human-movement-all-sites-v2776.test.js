// tests/chrome-extension/human-movement-all-sites-v2776.test.js
// 実行: node tests/chrome-extension/human-movement-all-sites-v2776.test.js
// 2026-11-15 竹内さん「ちゃんと人間の動きでできるようにする」
//
//   ★ 実測で分かった事
//     リアプロ（page-script.js）: `_clickEl` → `_humanPointerClick` でカーソルを動かしてから押す ✅
//     itandi（itandi-page-script.js）: `_humanClick` を**すべてのクリックが通る** ✅
//     ⚠ リアプロでも **3か所だけ** `simulateClick` を直に呼んでいた:
//       `div.next_step_button2`（次のステップ）・`ensureWardButtonY`（区を選び直す）・余計な区を外す
//
//   → リアプロの3か所を「カーソルが要素まで動いてから押す」に揃えた。
//     ⚠ カーソルの部品が無い・失敗しても**必ず押す**（止まらない）。
//
//   ⚠ **レインズは竹内さん「レインズは大丈夫」→ 触らない**（元のまま）。
//     触ると動きが変わる恐れがあるので、テストでも**レインズを対象にしない**。
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const dir = path.join(__dirname, "..", "..");
const ps = fs.readFileSync(path.join(dir, "chrome-extension", "page-script.js"), "utf8");
const it = fs.readFileSync(path.join(dir, "chrome-extension", "itandi-page-script.js"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

console.log("■ ① リアプロの残り3か所もカーソルを動かす（人の動き）");
{
  // 2.8.313: カーソルで押す入口は _pressHumanTracked（中で _humanPointerClick を呼び、押している間を数える）に集約された
  ok("  次のステップ（div.next_step_button2）", /_pressHumanTracked\(btnEl, function \(\) \{ try \{ simulateClick\(btnEl\)/.test(ps) && /function _pressHumanTracked\(el, fn, aim\) \{[\s\S]{0,400}p = _humanPointerClick\(el, fn, aim \|\| null\)/.test(ps));
  ok("  区を選び直す（ensureWardButtonY）", /_pressHumanTracked\(wTarget, function \(\) \{ try \{ simulateClick\(wTarget\)/.test(ps));
  // 2.8.313: 余計な区は _toggleCheckboxLikeHuman（中で enqueueHumanClick＝カーソルで1つずつ）で外す
  ok("  余計な区を外す（1つずつ・620〜1400ms）", /_toggleCheckboxLikeHuman\(extras\[ei\], false, 620, 1400/.test(ps) && /function _toggleCheckboxLikeHuman\(cb, wantOn, minGap, maxGap, flags\) \{[\s\S]{0,3000}enqueueHumanClick\(hit, function \(\)/.test(ps));
  ok("  ⚠ 失敗しても押す（_pressHumanTracked の catch で fn を直に呼ぶ）", /try \{ p = _humanPointerClick\(el, fn, aim \|\| null\); \} catch \(_\) \{\s*\n\s*try \{ fn\(el\); \} catch/.test(ps));
}

console.log("\n■ ② 既に人間らしい所は壊していない");
{
  ok("  リアプロの通常クリック（_clickEl → _humanPointerClick）", /void _humanPointerClick\(el, function \(x\) \{[\s\S]{0,200}try \{ x\.click\(\); \}/.test(ps));
  ok("  itandi は全部 _humanClick を通す", /function _humanClick\(el, opts\)/.test(it));
  ok("  ⚠ 区を押すのは1つずつ（620〜1400ms・2か所以上）", (ps.match(/_toggleCheckboxLikeHuman\([^)]*620, 1400/g) || []).length >= 2, (ps.match(/_toggleCheckboxLikeHuman\([^)]*620, 1400/g) || []).length);
  /**
   * ⚠ 区を押すコードで「ループ内の同期 simulateClick」が復活していないこと。
   *   （一気押しの原因だった・実測 128ms/136ms）
   */
  ok("  ⚠ ループ内の同期 simulateClick が残っていない", !/simulateClick\(lb2\); hitByCode/.test(ps) && !/simulateClick\(wardLabels\[i\]\);/.test(ps));
}

console.log("\n■ ③ レインズは触っていない（竹内さん「レインズは大丈夫」）");
{
  const rn = fs.readFileSync(path.join(dir, "chrome-extension", "reins-page-script.js"), "utf8");
  ok("  ⚠ レインズに _humanClick を足していない（元のまま）", !/function _humanClick\(el\)/.test(rn));
  ok("  レインズの構文が通る", (function () {
    try { execFileSync(process.execPath, ["--check", path.join(dir, "chrome-extension", "reins-page-script.js")], { stdio: "pipe" }); return true; }
    catch { return false; }
  })());
}

console.log("\n■ ④ 構文");
{
  let all = true;
  for (const f of ["page-script.js", "itandi-page-script.js"]) {
    try { execFileSync(process.execPath, ["--check", path.join(dir, "chrome-extension", f)], { stdio: "pipe" }); }
    catch { all = false; console.log("      ✗ " + f); }
  }
  ok("  page-script.js / itandi-page-script.js の構文が通る", all);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
