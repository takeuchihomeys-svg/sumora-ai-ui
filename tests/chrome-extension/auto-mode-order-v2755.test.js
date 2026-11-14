// tests/chrome-extension/auto-mode-order-v2755.test.js
// 実行: node tests/chrome-extension/auto-mode-order-v2755.test.js
// 2026-11-14 竹内さん「統括の部分はちゃんとできているか。さっき改善されたかな。プルダウンのところとか」
//
//   ⚠ 実測で分かった事: **自動モード（拡張が押す）では押した欄が1つも記録されていなかった**。
//     ・押した欄の名前・順番を作る `recordPoint` は `guarded`（**`isTrusted` だけ**）の中
//     ・拡張の `el.click()` は合成クリックなので `isTrusted=false` → **通らない**
//     → `point_fields` / `field_order` が空のまま＝「どの欄を・どの順で押したか」を学べない
//       （プルダウンの動きが学べない原因はこれ）
//
//   直した事（このテストで固定する）:
//     ① 受け口（click/change を人も拡張も拾う）でも**押した欄を積む**
//     ② 人の手本とは**混ぜない**（`by` で分ける・学習は human を優先）
//     ③ 合成クリックは位置を**真ん中**にする（`syn`）＝座標0,0 を「枠の外」で捨てない
//     ④ 押された**順番**を別に持つ（`_orderLive`）→ `field_order` になる
//     ⑤ 同じ欄の click→change は畳む（同じ欄が二重に並ばない）
//     ⑥ 人の記録が既にある時は**そちらを優先**（上書きしない）
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

console.log("■ ① 受け口でも押した欄を積む（自動モードで学ぶため）");
{
  ok("_pushPoint がある", /function _pushPoint\(el, by, ev\)/.test(code));
  ok("  受け口から呼ぶ", /_pushPoint\(e\.target, _by, e\)/.test(code));
  ok("  click と change の両方", /e\.type === "click" \|\| e\.type === "change"/.test(code));
}

console.log("\n■ ② 人の手本と混ぜない（by で分ける）");
{
  ok("by を渡している", /_pushPoint\(e\.target, _by, e\)/.test(code));
  ok("  欄ごとに by を残す", /by: by \|\| prev\.by \|\| null/.test(code));
  ok("  ⚠ 人の記録があれば上書きしない", /if \(!add\.points \|\| !add\.points\.fields \|\| !Object\.keys\(add\.points\.fields\)\.length\)/.test(code));
  ok("  ⚠ 順番も人の物を優先", /if \(!add\.order \|\| !add\.order\.length\)/.test(code));
}

console.log("\n■ ③ 合成クリックの位置は真ん中（枠の外で捨てない）");
{
  ok("syn を判定", /var syn = \(by === "auto"\)/.test(code));
  ok("  真ん中 0.5", /syn \? 0\.5 :/.test(code));
  ok("  ⚠ 捨てるのは『合成でない時だけ』", /if \(!syn && !\(fx >= -0\.2/.test(code));
}

console.log("\n■ ④ 押された順番を持つ（field_order になる）");
{
  ok("_orderLive がある", /var _orderLive = \[\];/.test(code));
  ok("  押されたら足す", /_orderLive\.push\(name\)/.test(code));
  ok("  field_order に渡す", /add\.order = _orderLive\.slice\(0, 40\)/.test(code));
  ok("  上限を切る（暴走しない）", /_orderLive\.length < 60/.test(code));
}

console.log("\n■ ⑤ 同じ欄の click→change を畳む");
{
  ok("同じ欄が400ms以内なら畳む", /cur\.__last\.f === name && t - Number\(cur\.__last\.t \|\| 0\) < 400/.test(code));
  ok("  ⚠ 畳んだ時は順番に足さない（return する）", /cur\.__last\.n = \(Number\(cur\.__last\.n\) \|\| 1\) \+ 1;[\s\S]{0,200}?return;/.test(code));
}

console.log("\n■ ⑥ 名前が取れない物は積まない（img/body を貯めない）");
{
  ok("名前が無ければ return", /if \(!name\) return;/.test(code));
  ok("  見えていない要素も積まない（幅・高さ0）", /if \(!r \|\| !\(r\.width > 0 && r\.height > 0\)\) return;/.test(code));
}

console.log("\n■ ⑦ 構文が壊れていない");
{
  let syntaxOk = true;
  try { new Function(rec); } catch (e) { syntaxOk = false; }
  ok("human-learn-record.js の構文が通る", syntaxOk);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
