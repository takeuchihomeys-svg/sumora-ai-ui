// tests/chrome-extension/start-is-called-v2757.test.js
// 実行: node tests/chrome-extension/start-is-called-v2757.test.js
// 2026-11-14 竹内さん「今録画されたのか。ちゃんと録画されているか確認できているか。強化されているのか」
//
//   ★ DBを見て判明（これが決定打だった）:
//     2.7.56 の `shot_ops` が `ring_empty: tab...: ring0: seen0: watchundefined` に戻っていた。
//     写真は撮れているのに**操作を1つも拾えていない**（2.7.49 で直した `seen0` の再発）。
//
//   ⚠ 真の原因: **`L` が最初からある時に `start()` を呼んでいなかった**。
//     2.7.49 で本体を `function start() { ... }` にまとめたが、
//     呼ぶのは `if (!L) { ...待つ... }` の中の `_bootAfterLib()` だけだった。
//     `L` がある（＝普通の状態）と `if` を素通りして、**宣言だけで終わっていた**
//     ＝ 関数を作ったが一度も実行していない（`_cap` も写真の見張りも付かない）。
//
//   なぜ写真だけ撮れていたか: `shootAfter` は `startShooting` からも呼ばれる別経路があるため。
//   → 操作の記録（`_cap` → `_pushOp`）だけが**丸ごと動いていなかった**。
//
//   直した事（このテストで固定する）:
//     ・`L` がある時も**必ず `_bootAfterLib()` を呼ぶ**（start が走る）
//     ・二重起動は `__axlxHumanLearnRecord` で防ぐ（今まで通り）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const rec = read("human-learn-record.js");
const code = rec.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

console.log("■ ① L がある時も start が走る（seen0 の再発を防ぐ）");
{
  ok("⚠ _bootAfterLib を if (!L) の外でも呼ぶ", /try \{ _bootAfterLib\(\); \} catch \(_\) \{\}/.test(code));
  const iIf = code.indexOf("if (!L) {");
  const iBoot = code.indexOf("try { _bootAfterLib(); } catch (_) {}");
  const iStartFn = code.indexOf("function start() {");
  ok("  ⚠ if (!L) より**後**にある", iIf > 0 && iBoot > iIf, { iIf, iBoot });
  ok("  ⚠ start() の宣言より**前**にある", iBoot > 0 && iStartFn > 0 && iBoot < iStartFn, { iBoot, iStartFn });
  ok("  二重起動を防ぐ印がある", /__axlxHumanLearnRecord/.test(code));
}

console.log("\n■ ② start() の中で操作を拾っている（_cap）");
{
  const iStart = code.indexOf("function start() {");
  const iCap = code.indexOf('document.addEventListener("click", _cap, true)');
  const iEnd = code.indexOf("} // start() ここまで");
  ok("start() の範囲が分かる", iStart > 0 && iEnd > iStart);
  ok("  _cap は start() の中", iCap > iStart && iCap < iEnd, { iStart, iCap, iEnd });
  ok("  _cap は人も拡張も拾う（isTrusted で弾かない）", !/if \(!e \|\| !e\.isTrusted\) return;/.test(code));
  ok("  _pushOp を呼ぶ", /_pushOp\(e\.type \|\| "click", e\.target, _by\)/.test(code));
}

console.log("\n■ ③ 写真の見張りも start() の中（同じ関数から始まる）");
{
  const iStart = code.indexOf("function start() {");
  const iShoot = code.indexOf("function startShooting() {");
  const iEnd = code.indexOf("} // start() ここまで");
  ok("startShooting は start() の中", iShoot > iStart && iShoot < iEnd, { iStart, iShoot, iEnd });
}

console.log("\n■ ④ 構文");
{
  let okSyntax = true;
  try { new Function(rec); } catch (e) { okSyntax = false; }
  ok("human-learn-record.js の構文が通る", okSyntax);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
