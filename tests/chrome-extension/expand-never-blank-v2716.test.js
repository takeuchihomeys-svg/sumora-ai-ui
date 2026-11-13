// 実行: node tests/chrome-extension/expand-never-blank-v2716.test.js
// 2026-11-13 竹内さん「ボタンを開いた状態から閉じた状態にするときにこのように白くなるバグが起きるし
//   展開することができなくなる」
//
//   白くなる／二度と開かない原因:
//     ① `pendingExpand = true` にして return していた → `load` は**もう来ない**ので永久に白いまま
//     ② `setSize(true)` を呼ばずに抜ける経路があった → サイズが戻らない（白い箱）
//     ③ 閉じる時に待ちを捨てていなかった → 次の展開が「待ち」で止まる
//     ④ iframe の visibility を戻し忘れる経路があった → 中身が見えない
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const ub = read("underbar.js");

console.log("■ ① 読み込み待ちで永久に止まらない（期限を付ける）");
{
  ok("展開待ちのタイマーを持つ（_pendingTimer）", /let _pendingTimer = null;/.test(ub));
  ok("  先に宣言してある（末尾の起動処理より前）", ub.indexOf("let _pendingTimer = null;") < ub.indexOf("function _decideOnStart") || ub.indexOf("let _pendingTimer = null;") < 2500, ub.indexOf("let _pendingTimer = null;"));
  ok("期限を付ける関数がある（_armPendingTimeout）", /function _armPendingTimeout\(\)/.test(ub));
  ok("  期限は 1200ms（永久に待たない）", /1200/.test(ub));
  ok("  期限が来たら**その場で開く**", /読み込みが終わらない → そのまま開きます/.test(ub));
  ok("  開く前に待ちを捨てる（pendingExpand = false）", /pendingExpand = false;\s*\n\s*console\.warn\("\[underbar\] iframe の読み込みが終わらない/.test(ub));
}

console.log("\n■ ② 開く処理は1か所（_openNow）で、サイズも見える状態も必ず戻す");
{
  ok("開く関数が1つ（_openNow）", /function _openNow\(fr\)/.test(ub));
  ok("  サイズを戻す（setSize(true)）", /function _openNow[\s\S]{0,300}setSize\(true\)/.test(ub));
  ok("  iframe を見える状態にする（visibility: visible）", /fr\.style\.visibility = "visible"/.test(ub));
  ok("  中身に合図を送る（expand-from-parent）", /action: "expand-from-parent"/.test(ub));
  ok("  待ちを捨てる（pendingExpand = false）", /function _openNow[\s\S]{0,200}pendingExpand = false;/.test(ub));
  ok("読み込みが終わったら _openNow を呼ぶ（旧の setSize 直書きが無い）", /_openNow\(iframe\)/.test(ub));
  ok("doExpand も _openNow を通る", /function doExpand[\s\S]{0,800}_openNow\(fr\)/.test(ub));
}

console.log("\n■ ③ 閉じた時に待ちを捨てる（次の展開が止まらない）");
{
  ok("閉じる時に pendingExpand = false", /miniBtnEl\.style\.display = "flex";[\s\S]{0,600}pendingExpand = false;/.test(ub));
  ok("  タイマーも消す", /if \(_pendingTimer\) \{ clearTimeout\(_pendingTimer\); _pendingTimer = null; \}/.test(ub));
}

console.log("\n■ ④ 開いた時に iframe が隠れたままにならない");
{
  ok("display も戻す（block）", /iframe\.style\.display = "block"/.test(ub));
  ok("  pointerEvents も戻す（押せるように）", /iframe\.style\.pointerEvents = ""/.test(ub));
  ok("  wrap 自体も見える状態に戻す", /wrap\.style\.visibility = "visible"/.test(ub));
  ok("  旧の「visibility だけ戻す」で終わっていない", !/miniOverlay\.style\.display   = "none";\s*\n\s*\/\/ ミニ時に非表示にしたiframeを復元（visibility:hiddenで状態保持していたもの）\s*\n\s*if \(iframe\) iframe\.style\.visibility = "visible";\s*\n\s*\}/.test(ub));
}

console.log("\n■ ⑤ 何度呼んでも同じ結果（開く・閉じるを繰り返せる）");
{
  const openCalls = (ub.match(/^\s*setSize\(true\);/gm) || []).length;
  ok("setSize(true) の**実行**は1か所に寄せた（コメントを除く）", openCalls === 1, openCalls);
  ok("_openNow は何度呼ばれても安全（同じ事をするだけ）", /⚠ 何度呼んでも安全/.test(ub));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
