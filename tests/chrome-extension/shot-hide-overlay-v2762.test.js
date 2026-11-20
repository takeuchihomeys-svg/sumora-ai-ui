// tests/chrome-extension/shot-hide-overlay-v2762.test.js
// 実行: node tests/chrome-extension/shot-hide-overlay-v2762.test.js
// 2026-11-14 竹内さん「1から順に進めていく」「動かし方学習お願い」「データベースから」
//
//   ★ 実測で判明（写真から学習できなかった一番の原因）:
//     写真の**中央に拡張自身の小窓**（「AIXLINX 物件検索サポート」「案内」「学習中」）が写っている。
//     そのため写真から欄を読ませると、**サイトの欄ではなく拡張のボタン**を読んでいた:
//
//       実物のボタン : ピンポイント / 広げて検索 / リアプロで自動検索 / レインズでも探す / 全条件をコピー
//       AI の読み取り : ビジポイント / 近い順で検索 / リアプロで看護師募集 / Banch何度も利用 / 全自動キーコピー
//
//   2.7.62〜2.8.140 は「撮る瞬間だけ小窓を隠して戻す」だった。
//   ★ 2.8.141 竹内さん「白黒にフラッシュになってしまう」:
//     ・自動の回は写真が 400ms おき → 1秒に2〜3回、小窓が消えて戻る＝点滅。
//     ・さらに見えるカーソルの印（html の class）が `[class*='axlx-']` に当たり、**ページ全体**が消えていた（写真 14枚が真っ白）。
//   → **画面には触らない**。窓の位置だけ返し、撮った写真のその所を灰色で塗る。
//
// ⚠ このテストは「塗る仕組みが**両方の撮影経路**にあり、**画面を隠す処理が残っていない**」ことを固定する。
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const bg = read("background.js");
const rec = read("human-learn-record.js");
const ptr = read("pointer-ui.js");
const strip = (s) => s.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
const bgCode = strip(bg);
const recCode = strip(rec);
const ptrCode = strip(ptr);

console.log("■ ① 撮る側（background）は窓の位置を聞いて写真を塗る");
{
  ok("_shotMaskInfo がある", /async function _shotMaskInfo\(tabId\)/.test(bgCode));
  ok("  content script に axlx-shot-rects を送る（上のフレームだけ）", /type:\s*"axlx-shot-rects" \}, \{ frameId: 0 \}/.test(bgCode));
  ok("_maskShot がある", /async function _maskShot\(dataUrl, info\)/.test(bgCode));
  ok("  灰色一色で塗る", /fillStyle = "#808080"/.test(bgCode));
  ok("  失敗したら塗らない写真を返す（撮影は止めない）", /catch \(_\) \{\s*return dataUrl;\s*\}/.test(bgCode));
}

console.log("\n■ ② 撮影の**両方の経路**で塗っている（片方だけ直すと漏れる）");
{
  const asks = bgCode.match(/await _shotMaskInfo\(tab\.id\)/g) || [];
  ok("  位置を聞く呼び出しが2か所（通常経路＋やり直し経路）", asks.length === 2, { asks: asks.length });
  const masks = bgCode.match(/dataUrl = await _maskShot\(dataUrl, _mask2?\)/g) || [];
  ok("  塗る呼び出しも2か所", masks.length === 2, { masks: masks.length });
}

console.log("\n■ ③ ⚠ 画面を隠す処理が残っていない（点滅の元）");
{
  ok("  background に _setShotHidden が無い", !/_setShotHidden/.test(bgCode));
  ok("  background が axlx-shot-hide を送らない", !/axlx-shot-hide/.test(bgCode));
  ok("  content script に _hideForShot が無い", !/_hideForShot/.test(recCode));
  ok("  content script に _showAfterShot が無い", !/_showAfterShot/.test(recCode));
  ok("  content script が style.visibility / opacity を書き換えない（撮影の所）",
    !/style\.setProperty\("(visibility|opacity)"/.test(recCode) && !/style\.visibility = "hidden"/.test(recCode));
}

console.log("\n■ ④ 窓の位置を返す側（content script）");
{
  ok("_shotMaskRects がある", /function _shotMaskRects\(\)/.test(recCode));
  ok("  axlx-shot-rects の受け口がある", /msg\.type !== "axlx-shot-rects"/.test(recCode));
  const sel = (recCode.match(/var SHOT_HIDE_SEL = ([\s\S]{0,300}?);/) || [])[1] || "";
  ok("  セレクタに拡張の印が入っている", /axlx|aixlinx/.test(sel), sel.slice(0, 120));
  ok("  ⚠ aixlinx-float-wrap を拾う", /\[id\^='aixlinx-'\]/.test(sel));
  ok("  クラスも部分一致で拾う", /\[class\*='axlx-'\]/.test(sel));
  ok("  ⚠ html・body は塗らない", /if \(el === root \|\| el === body\) continue;/.test(recCode));
  ok("  ⚠ 画面の 85% 以上を覆う物は窓ではない", /ratio >= 0\.85/.test(recCode));
  ok("  面積が 2% 未満の物は塗らない", /ratio < 0\.02/.test(recCode));
}

console.log("\n■ ⑤ ⚠ 見えるカーソルの html の印が「拡張の要素」に当たらない（ページ全体が消えた元）");
{
  const cls = (ptrCode.match(/var OS_CLS = "([^"]+)";/) || [])[1] || "";
  ok("  印の名前がある", !!cls, cls);
  ok("  ⚠ 印に axlx- / aixlinx- を含めない", !/axlx-|aixlinx-/.test(cls), cls);
  ok("  旧の印（axlx-one-cursor）は外す", /OS_CLS_OLD = "axlx-one-cursor"/.test(ptrCode) && /classList\.remove\(OS_CLS_OLD\)/.test(ptrCode));
  ok("  古い style が残っていても新しい印の CSS に直す", /s\.textContent !== css/.test(ptrCode));
}

console.log("\n■ ⑥ プロンプトも「小窓・灰色の所を読まない」と言っている（二重の守り）");
{
  const sl = fs.readFileSync(path.join(dir, "..", "app", "lib", "shot-learn.ts"), "utf8");
  ok("  指示文に小窓の除外がある", /拡張機能の小窓|AIXLINX/.test(sl));
  ok("  読めない時は null と書いてある", /name を null にする/.test(sl));
  const sls = fs.readFileSync(path.join(dir, "..", "app", "lib", "shot-learn-server.ts"), "utf8");
  ok("  全体を読む指示に「灰色の四角は読まない」がある", /灰色一色の四角は拡張の窓を塗りつぶした所/.test(sls));
}

console.log("\n■ ⑦ 構文");
{
  /**
   * ⚠ `new Function(bg)` は background.js では通らない（`importScripts` 等の
   *   Service Worker 専用の書き方を含むため・構文の誤りではない）。
   *   → **`node --check` と同じ判定**（パースできるか）を使う。
   */
  const { execFileSync } = require("child_process");
  const check = (f) => {
    try { execFileSync(process.execPath, ["--check", path.join(dir, f)], { stdio: "pipe" }); return true; }
    catch { return false; }
  };
  ok("background.js の構文が通る", check("background.js"));
  ok("human-learn-record.js の構文が通る", check("human-learn-record.js"));
  ok("pointer-ui.js の構文が通る", check("pointer-ui.js"));
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
