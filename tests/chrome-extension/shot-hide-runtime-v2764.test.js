// tests/chrome-extension/shot-hide-runtime-v2764.test.js
// 実行: node tests/chrome-extension/shot-hide-runtime-v2764.test.js
// 2026-11-14 竹内さん「これで改善されたかな」
//
//   ⚠ 前のテスト（shot-hide-overlay-v2762）は**文字があるか**しか見ていなかった。
//     それでは「隠す関数が本当に隠すか」は分からない（動かして確かめる必要がある）。
//
//   このテストは **偽の DOM を作って、本物の `_hideForShot` / `_showAfterShot` を動かす**。
//     ・画面の 2% 以上の拡張の窓 → 隠れる
//     ・小さい印（学習中バッジ） → 隠さない（人が不安にならない）
//     ・サイトの要素 → 触らない
//     ・戻す時 → 元の値に戻る（`""` の人も `visible` の人も元のまま）
//     ・2回隠しても壊れない（`_shotHidden` が二重にならない）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const src = fs.readFileSync(path.join(dir, "human-learn-record.js"), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

/**
 * 本物の `_hideForShot` / `_showAfterShot` の**中身**を取り出して、
 * 偽の `document` / `window` の下で動かす（写しではなく本物を動かす）。
 */
function extractFn(name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " が見つからない");
  let d = 0, i = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

/** 偽の要素（`style.visibility` と `getBoundingClientRect` だけ持つ） */
function fakeEl(id, w, h) {
  return {
    id,
    style: { visibility: "" },
    getBoundingClientRect: () => ({ width: w, height: h, left: 0, top: 0, right: w, bottom: h }),
  };
}

function runHide(els, vw, vh) {
  const hideSrc = extractFn("_hideForShot");
  const showSrc = extractFn("_showAfterShot");
  const fakeDoc = {
    querySelectorAll: (sel) => {
      // セレクタは「拡張の印」で絞る物なので、偽の要素のうち印がある物だけ返す
      if (/axlx|aixlinx/.test(sel)) return els.filter((e) => /axlx|aixlinx/.test(e.id));
      return [];
    },
    body: { querySelectorAll: () => els },
  };
  const fakeWin = { innerWidth: vw, innerHeight: vh };
  // 本物の関数を組み立てる（var _shotHidden も本物の宣言を使う）
  const factory = new Function(
    "document", "window",
    "var _shotHidden = [];\n"
    + "var SHOT_HIDE_SEL = \"[id^='axlx-'], [id^='aixlinx-']\";\n"
    + hideSrc + "\n" + showSrc + "\n"
    + "return { hide: _hideForShot, show: _showAfterShot, count: function () { return _shotHidden.length; } };",
  );
  return factory(fakeDoc, fakeWin);
}

console.log("■ ① 画面を覆う拡張の窓は隠れる（実測で確認したID）");
{
  const big = fakeEl("aixlinx-float-wrap", 520, 400);   // 中央の大きな窓
  const bar = fakeEl("axlx-bar", 220, 300);             // 右の操作パネル
  const site = fakeEl("suumo-list", 1200, 600);         // サイトの要素
  const api = runHide([big, bar, site], 1920, 1080);
  api.hide();
  ok("  中央の大きな窓が隠れる", big.style.visibility === "hidden", big.style.visibility);
  ok("  右の操作パネルが隠れる", bar.style.visibility === "hidden", bar.style.visibility);
  ok("  ⚠ サイトの要素は触らない", site.style.visibility === "", site.style.visibility);
  ok("  隠した数は2", api.count() === 2, api.count());
}

console.log("\n■ ② 小さい印は残す（人が『あれ？消えた』とならない）");
{
  const badge = fakeEl("axlx-learn-badge", 100, 20);    // 学習中の小さな印
  const api = runHide([badge], 1920, 1080);
  api.hide();
  ok("  ⚠ 小さい印は隠さない（面積2%未満）", badge.style.visibility === "", badge.style.visibility);
  ok("  隠した数は0", api.count() === 0);
  const small = fakeEl("axlx-learn-badge", 100, 20);
  const api2 = runHide([small], 400, 300);              // 100x20 / 400x300 = 1.67%（まだ2%未満）
  api2.hide();
  ok("  1.67% では隠さない（しきい値2%の手前）", small.style.visibility === "", small.style.visibility);
  const mid = fakeEl("axlx-learn-badge", 100, 20);
  const api3 = runHide([mid], 320, 240);                // 100x20 / 320x240 = 2.6%（2%超え）
  api3.hide();
  ok("  ⚠ 2.6% なら隠す（面積比で決めている）", mid.style.visibility === "hidden", mid.style.visibility);
}

console.log("\n■ ③ 戻すと元の値に戻る（`visible` を指定していた物も元のまま）");
{
  const a = fakeEl("aixlinx-float-wrap", 520, 400);
  const b = fakeEl("axlx-bar", 220, 300);
  b.style.visibility = "visible";                       // 元から visible だった
  const api = runHide([a, b], 1920, 1080);
  api.hide();
  ok("  隠れている", a.style.visibility === "hidden" && b.style.visibility === "hidden");
  api.show();
  ok("  ⚠ 元が空だった物は空に戻る", a.style.visibility === "", a.style.visibility);
  ok("  ⚠ 元が visible だった物は visible に戻る", b.style.visibility === "visible", b.style.visibility);
  ok("  一覧が空になる", api.count() === 0);
}

console.log("\n■ ④ 2回隠しても壊れない（撮影が重なった時）");
{
  const a = fakeEl("aixlinx-float-wrap", 520, 400);
  const api = runHide([a], 1920, 1080);
  api.hide();
  api.hide();                                            // 2回目は何もしない
  ok("  1つだけ覚えている", api.count() === 1, api.count());
  api.show();
  ok("  ⚠ 2回隠しても元に戻る（空のまま消えない）", a.style.visibility === "", a.style.visibility);
}

console.log("\n■ ⑤ 隠した後に撮って戻す順番（本物のコードで確認）");
{
  const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8").replace(/\r\n/g, "\n");
  const i = bg.indexOf("async function _setShotHidden");
  const seg = bg.slice(i, i + 1600);
  ok("  隠す → 32ms 待つ（描画待ち）", /if \(hide !== false\) await new Promise\(function \(r\) \{ setTimeout\(r, 32\); \}\);/.test(seg));
  ok("  戻す時は待たない", !/hide !== false/.test(seg.split("setTimeout(r, 32)")[1] || ""));
  const calls = bg.match(/_setShotHidden\(tab\.id, true\)/g) || [];
  ok("  ⚠ 両方の撮影経路で隠す（2か所）", calls.length === 2, calls.length);
  ok("  ⚠ 必ず finally で戻す", (bg.match(/finally \{[\s\S]{0,200}?_setShotHidden\(tab\.id, false\)/g) || []).length >= 1);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
