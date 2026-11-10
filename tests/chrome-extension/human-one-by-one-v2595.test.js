// 実行: node tests/chrome-extension/human-one-by-one-v2595.test.js
// 2026-11-10 竹内さん「ちゃんと人間のように1つずつ動くようになっているか／今一気に動くようになっていないか」
//   「1件ずつのダウンロードとなりそして時間差も人間が確認するように」「まずリアプロから徹底的に」
//   ① リアプロの一覧の全選択は1件ずつ（一瞬で checked=true にしない）
//   ② 押す間は対数正規（等間隔にしない）・たまに一息
//   ③ 資料は既定で1件ずつ取りに行く（束の間は「人がPDFを見る間」）
//   ④ 選び終わってから資料を取りに行くまでに「一覧を目で追う間」
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const bd = read("bulk-dl.js");
const ib = read("itandi-bulk-dl.js");
const H = require(path.join(dir, "human-wait.js"));

console.log("■ ① 一覧の全選択は1件ずつ");
ok("リアプロ: _humanCheckAll がある（1件ずつ click）", /function _humanCheckAll\(cbs, next\) \{/.test(bd) && /cb\.click\(\);/.test(bd));
ok("リアプロ: 全選択で tracked.forEach の一括 checked=true をしていない", !/function autoSendOnePage[\s\S]{0,1200}tracked\.forEach\(function \(t\) \{ t\.cb\.checked = true; \}\);/.test(bd));
ok("リアプロ: 押す前に画面へ入れる（scrollIntoView）", /cb\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/.test(bd));
ok("ITANDI: 同じ形の1件ずつ（_humanCheckAll）", /function _humanCheckAll\(cbs, next\) \{/.test(ib));

console.log("\n■ ② 間は対数正規・たまに一息");
ok("リアプロ: 押す間に対数正規を使う", /_humanCheckAll[\s\S]{0,800}logNormalDelay/.test(bd));
ok("リアプロ: 8%ほどで一息（400〜1100ms）", /Math\.random\(\) < 0\.08\) wait \+= 400 \+ Math\.floor\(Math\.random\(\) \* (700|600)/.test(bd + ib));
// 対数正規そのもの: 同じ中央値でも毎回違う・偏る（等間隔でない）
(() => {
  const xs = Array.from({ length: 300 }, () => H.logNormalDelay(220, 0.32));
  const uniq = new Set(xs).size;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  ok("logNormalDelay: 毎回ちがう値になる（300回でミリ秒の丸めの中でも種類が多い）", uniq > 80, { uniq });
  ok("logNormalDelay: ばらつく（CV > 0.2）", sd / mean > 0.2, { cv: (sd / mean).toFixed(2) });
  ok("logNormalDelay: 下限 200ms を下回らない", Math.min(...xs) >= 200, { min: Math.min(...xs) });
})();

console.log("\n■ ③ 資料は1件ずつ・束の間に人が確認する間");
ok("既定の束は1件", /var SEND_BATCH_SIZE_DEFAULT = 1;/.test(bd));
ok("束の大きさを変えられる（axlxSendBatchSize）", /sessionStorage\.getItem\("axlxSendBatchSize"\)/.test(bd));
ok("束の間は 2〜12秒の対数正規（1件ずつの時）", /_perItem \? 3400 : 3600/.test(bd) && /_perItem \? 12000 : 20000/.test(bd));
ok("束の間に 12%ほどで一息を足す", /Math\.random\(\) < 0\.12\) _confirmGap \+= 800 \+ Math\.floor\(Math\.random\(\) \* 1500\)/.test(bd));
ok("「資料を確認中…」と画面に出す（人が見ている形）", /資料を確認中…/.test(bd));

console.log("\n■ ④ 選び終わってから資料を取りに行くまでに目で追う間");
ok("_doSend はすぐ送らず _doSendAfterLook へ渡す", /setTimeout\(function \(\) \{ _doSendAfterLook\(sendUrls\); \}, _lookGap\);/.test(bd));
ok("目で追う間は 1.2〜8秒の対数正規", /logNormalDelay\(2200, 0\.4\)/.test(bd) && /if \(_lookGap > 8000\) _lookGap = 8000;/.test(bd));
ok("「送る部屋を確認中…」と画面に出す", /送る部屋を確認中…/.test(bd));

console.log("\n■ ⑤ 点検の記録に残す（あとで人と自動を比べる）");
ok("look_wait を点検に残す", /_tmark\("look_wait"/.test(bd));
ok("confirm_wait を点検に残す", /_tmark\("confirm_wait"/.test(bd));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
