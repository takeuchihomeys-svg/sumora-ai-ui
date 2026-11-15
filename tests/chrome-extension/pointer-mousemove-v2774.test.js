// tests/chrome-extension/pointer-mousemove-v2774.test.js
// 実行: node tests/chrome-extension/pointer-mousemove-v2774.test.js
// 2026-11-15 竹内さん「ちゃんと人間の動きでできるようにする」
//
//   ★ 実測で分かった**核心**（直す前）
//     自動モード（aix）の記録 54件のうち「カーソルの動き」があるのは **19件（35%）だけ**。
//     65% は「カーソルを動かさずに押している」状態だった。
//     ⚠ 原因: `pointer-ui.js` の `moveTo` は**見えるカーソル（DOM の丸）を動かすだけ**で、
//       `mousemove` イベントを**一度も出していなかった**（実測 0箇所）。
//       記録側（`human-learn.js` の `hMove`）は **`mousemove` でしか学ばない**ので、
//       どれだけ丁寧に動かしても**記録に残らない**＝「人の動き」として学べない。
//
//   → 点を動かすたび・止まる時・迷う時に **`mousemove` を出す**。
//     ⚠ `isTrusted: false`（拡張が作った）なので、記録側は `by:"auto"` で区別できる。
//     ⚠ 出せなくてもカーソルは動く（止まらない）。
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const dir = path.join(__dirname, "..", "..");
const pu = fs.readFileSync(path.join(dir, "chrome-extension", "pointer-ui.js"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

console.log("■ ① 動くたびに mousemove を出す（記録に残すため）");
{
  ok("  ⚠ MouseEvent を出している", /new MouseEvent\("mousemove"/.test(pu));
  ok("  ⚠ 移動の各点で出している（moveTo の step）", /_place\(p\.x, p\.y\);[\s\S]{0,1200}?new MouseEvent\("mousemove"/.test(pu));
  ok("  ⚠ 終点でも出している（押す直前の位置）", /_place\(t\.x, t\.y\);[\s\S]{0,900}?new MouseEvent\("mousemove"/.test(pu));
  ok("  ⚠ 近すぎて動かない時も出す（同じ所を続けて押す時）", /if \(dist < 4\)[\s\S]{0,900}?new MouseEvent\("mousemove"/.test(pu));
  ok("  ⚠ 迷っている間も出す（押す前に迷うのは人の特徴）", /_place\(_pos\.x, _pos\.y\);[\s\S]{0,900}?new MouseEvent\("mousemove"/.test(pu));
}

console.log("\n■ ② 出し方の決まり（サイトを壊さない）");
{
  ok("  bubbles: true（上へ伝わる＝記録側が拾える）", /bubbles: true/.test(pu));
  ok("  cancelable: true（サイトが止められる）", /cancelable: true/.test(pu));
  ok("  buttons: 0（押していない時の動き）", /buttons: 0/.test(pu));
  ok("  ⚠ clientX/Y と screenX/Y の両方", /clientX: Math\.round/.test(pu) && /screenX: Math\.round/.test(pu));
  ok("  ⚠ 出せなくても止まらない（try/catch）", (pu.match(/new MouseEvent\("mousemove"[\s\S]{0,600}?catch \(_\) \{\}/g) || []).length >= 3);
  ok("  ⚠ サイトの要素は触らない（イベントを出すだけ）", !/dispatchEvent[\s\S]{0,100}?\.click\(\)/.test(pu));
}

console.log("\n■ ③ 記録側は mousemove で学ぶ（配線の確認）");
{
  const hl = fs.readFileSync(path.join(dir, "chrome-extension", "human-learn.js"), "utf8");
  ok("  human-learn が mousemove を拾う", /on\("mousemove", hMove/.test(hl));
  ok("  recordMove に渡している", /recordMove\(e\.clientX, e\.clientY, e\.buttons/.test(hl));
  ok("  ⚠ 拡張の操作は by=\"auto\" で区別できる（isTrusted が false）", /e\.isTrusted === true\) \? "human" : "auto"/.test(hl) || /isTrusted/.test(hl));
}

console.log("\n■ ④ 構文");
{
  let okc = true;
  try { execFileSync(process.execPath, ["--check", path.join(dir, "chrome-extension", "pointer-ui.js")], { stdio: "pipe" }); }
  catch { okc = false; }
  ok("  pointer-ui.js の構文が通る", okc);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
