// tests/chrome-extension/capture-first-v2758.test.js
// 実行: node tests/chrome-extension/capture-first-v2758.test.js
// 2026-11-14 竹内さん「録画したのちゃんと反映されるようにする」
//
//   ⚠ 何度直しても `ops=0 / seen0` が続いた（実測: 20:43 の記録が最後・全部 ops=0）。
//     `start()` は呼ばれるようになったが、**その先頭**で `L.create()` を呼んでおり、
//     そこで例外が出ると**以降が全部止まる**（＝操作を拾う `_cap` まで到達しない）。
//     ＝ 「写真は撮れているのに操作が0」という一番分かりにくい壊れ方になる。
//
//   直した事（このテストで固定する）:
//     ① **操作の記録（_cap）を最初に付ける**（`_attachOpCapture` を start の先頭で呼ぶ）
//     ② **写真の見張りも最初に付ける**（`_bootShooting`・モード待ちにしない）
//     ③ `L.create()` など準備は後ろ（失敗しても記録と写真は動く）
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

console.log("■ ① 操作の記録を最初に付ける");
{
  ok("_attachOpCapture がある", /function _attachOpCapture\(\)/.test(code));
  ok("  _cap を付けている", /document\.addEventListener\("click", _cap, true\)/.test(code));
  ok("  click と change の両方", /document\.addEventListener\("change", _cap, true\)/.test(code));
  const iStart = code.indexOf("function start() {");
  const iAttach = code.indexOf("try { _attachOpCapture(); }");
  const iCreate = code.indexOf("rec = L.create(");
  ok("  ⚠ start() の**先頭**で呼ぶ", iAttach > iStart, { iStart, iAttach });
  ok("  ⚠ L.create より**前**（そこで落ちても記録は動く）", iAttach < iCreate, { iAttach, iCreate });
}

console.log("\n■ ② 写真の見張りも最初に付ける（モード待ちにしない）");
{
  ok("_bootShooting がある", /function _bootShooting\(\)/.test(code));
  ok("  start() の先頭で呼ぶ", /try \{ _bootShooting\(\); \} catch \(_\) \{\}/.test(code));
  const iBoot = code.indexOf("try { _bootShooting(); }");
  const iCreate = code.indexOf("rec = L.create(");
  ok("  ⚠ L.create より前", iBoot > 0 && iBoot < iCreate, { iBoot, iCreate });
  ok("  撮る設定だけ見る（モードを見ない）", /function _bootShooting\(\) \{[\s\S]{0,200}?shouldShoot/.test(code));
}

console.log("\n■ ③ 失敗しても記録は止まらない（例外を握る）");
{
  const seg = code.slice(code.indexOf("function _attachOpCapture()"), code.indexOf("function _attachOpCapture()") + 2200);
  ok("全体を try で囲む", /function _attachOpCapture\(\) \{\s*try \{/.test(seg));
  ok("  各操作の処理も try（1つ失敗しても次を拾う）", /catch \(_\) \{\}/.test(seg));
  ok("  拡張自身のUIは除外", /axlx-bar/.test(seg));
}

console.log("\n■ ③ 状態の変数が受け口より**先**に宣言されている（seen0 の真の原因）");
{
  /**
   * ⚠ これが今回の真の原因だった:
   *   `_attachOpCapture()` を先頭で呼んでも、その中で使う `_opsRing` などの `var` 宣言が
   *   **下にあった**ため `undefined` になり、`_opsRing.push` で例外→握り潰し→`seen0`。
   *   → 変数の宣言が `_attachOpCapture()` の**前**にあることを確かめる。
   */
  const iStart = code.indexOf("function start() {");
  const iAttach = code.indexOf("try { _attachOpCapture(); }");
  ok("start() と受け口の位置が分かる", iStart > 0 && iAttach > iStart);
  for (const v of ["_opsRing", "_opsSeen", "_livePoints", "_orderLive", "watching", "_shooting"]) {
    const iDecl = code.indexOf(`var ${v} = `, iStart);
    ok(`  ⚠ ${v} を受け口より前に宣言`, iDecl > iStart && iDecl < iAttach, { v, iDecl, iAttach });
  }
  ok("  ⚠ _attachOpCapture の後ろに var の再宣言が無い（上書きしない）",
    (code.match(/^\s*var _opsRing = \[\]/gm) || []).length <= 1);
}

console.log("\n■ ④ 押した欄と順番も同じ受け口で積む");
{
  ok("_pushPoint を呼ぶ", /_pushPoint\(e\.target, _by, e\)/.test(code));
  ok("  by（人/機械）を残す", /var _by = \(e\.isTrusted === true\) \? "human" : "auto";/.test(code));
}

console.log("\n■ ⑤ 構文");
{
  let okSyntax = true;
  try { new Function(rec); } catch (e) { okSyntax = false; }
  ok("human-learn-record.js の構文が通る", okSyntax);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
