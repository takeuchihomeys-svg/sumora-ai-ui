// tests/chrome-extension/sort-fail-continue-v2751.test.js
// 実行: node tests/chrome-extension/sort-fail-continue-v2751.test.js
// 2026-11-14 竹内さん「検索した後並び替えしっぱいしたとでてから印刷用PDF押す前に止まってしまった
//   原因見つけて改善する」
//
//   ⚠ 旧の動き（実測・写真で確認）:
//     並べ替えが失敗 → `_nudge("⚠ 並べ替えができませんでした。自動では押しません")` → **return（押さない）**
//     ＝ **印刷用PDF を押す前に停止** → 物件が1件も出ない（現場が止まる）。
//   ⚠ しかも失敗の理由は `sessionStorage` の `_tmark` だけだったので**私からは見えなかった**。
//
//   直した事（このテストで固定する）:
//     ① **3回までリトライ**（メニューが開くまでの時間が足りないだけの事が多い）
//     ② それでも駄目なら**この並びのまま続行**（物件を落とさない方を優先）
//     ③ 失敗した段を**点検に送る**（sort_no_head / sort_no_ad / sort_no_hilo ＋ 見えていた短い文字）
//     ④ 点検に送るのは**メニューの文字だけ**（物件名・家賃・お客様の情報は入れない）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const bd = read("bulk-dl.js");
const code = bd.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

console.log("■ ① 失敗しても止まらない（押さない return をやめた）");
{
  ok("⚠ 並べ替え失敗で return して押さない、をやめた", !/並べ替えができませんでした。自動では押しません/.test(code));
  ok("  代わりに続行する", /この並びのまま押します/.test(code) || /この並びのまま押します/.test(bd));
  ok("  続行時に go() を呼ぶ", /_tmark\("ad_sort", "failed_continue"\)[\s\S]{0,120}?if \(typeof go === "function"\) go\(\)/.test(code));
  ok("  点検に残す（黙って続けない）", /failed_continue/.test(code));
  ok("  画面にも出す", /並べ替えできませんでした（この並びのまま続けます）/.test(bd));
}

console.log("\n■ ② 3回までリトライする");
{
  ok("_maxTry = 3", /var _maxTry = 3;/.test(code));
  ok("  失敗したらやり直す", /if \(_try < _maxTry\)/.test(code));
  ok("  少し待ってから（1.5〜2.7秒）", /1500 \+ Math\.floor\(Math\.random\(\) \* 1200\)/.test(code));
  ok("  ⚠ 1回分を _sortOnce に分けた", /function _sortOnce\(done\)/.test(code));
  ok("  入口は _sortByAdLikeHuman", /function _sortByAdLikeHuman\(done\)/.test(code));
}

console.log("\n■ ③ 失敗した段を点検に送る（どの段で止まったか分かる）");
{
  ok("sort_no_head（並べ替えが見つからない）", /_auditSort\("sort_no_head"/.test(code));
  ok("sort_no_ad（AD が見つからない）", /_auditSort\("sort_no_ad"/.test(code));
  ok("sort_no_hilo（高→低 が見つからない）", /_auditSort\("sort_no_hilo"/.test(code));
  ok("  成功した段も残す（どこまで進んだか）", /_auditSort\("sort_head"/.test(code) && /_auditSort\("sort_ad"/.test(code));
  ok("  見えていた短い文字も送る", /_visibleWords\(\)/.test(code));
}

console.log("\n■ ④ 点検に物件情報・個人情報を入れない");
{
  const seg = bd.slice(bd.indexOf("var _visibleWords"), bd.indexOf("var _visibleWords") + 1400);
  ok("⚠ 数字だけの文字は入れない", /\^\[0-9\.\,\]\+\$/.test(seg) || /\[0-9\.,\]/.test(seg));
  ok("⚠ 家賃・㎡ は入れない", /万円\|円\|㎡\|m2/.test(seg));
  ok("  短い文字だけ（2〜12字）", /t\.length < 2 \|\| t\.length > 12/.test(seg));
  ok("  最大6件", /out\.length < 6/.test(seg));
}

console.log("\n■ ⑤ 構文が壊れていない");
{
  let syntaxOk = true;
  try { new Function(bd); } catch (e) { syntaxOk = false; }
  ok("bulk-dl.js の構文が通る", syntaxOk);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
