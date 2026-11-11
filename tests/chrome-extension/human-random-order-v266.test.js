// 実行: node tests/chrome-extension/human-random-order-v266.test.js
// 2026-11-10 竹内さん「このようにほかの部分もちゃんとランダムで選択できるように／まだ人間的になっていない部分がある可能性ある」
//   ① チェックボックスの選択順が毎回ちがう（DOM の上から固定ではない）
//   ② 選ぶ集合は変えない（入れ忘れ・余計に入れない）
//   ③ ITANDI の間取りも毎回ちがう順
//   ④ 間隔はすべて人らしい範囲（速い固定値が残っていない）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const ps = read("page-script.js");
const ips = read("itandi-page-script.js");

console.log("■ ① チェックボックスの順が毎回ちがう");
ok("setCheckboxes が対象を並べ替えてから積む", /var targets = cbs\.filter\(function \(cb\) \{ return cb\.checked !== \(svals\.indexOf\(String\(cb\.value\)\) >= 0\); \}\);/.test(ps) && /targets\.sort\(function \(a, b\) \{/.test(ps));
ok("並べ替えに乱数が入っている（固定順でない）", /var aw = ai \+ Math\.random\(\) \* cbs\.length \* 0\.9;/.test(ps));
ok("旧の「DOM の並びのまま forEach」ではない", !/cbs\.forEach\(function\(cb\) \{\s*var shouldCheck/.test(ps));

console.log("\n■ ② 選ぶ集合は変えない");
ok("対象は「今と違う物」だけ（入れ忘れ・余計なし）", /cb\.checked !== \(svals\.indexOf\(String\(cb\.value\)\) >= 0\)/.test(ps));
ok("入れる側の guard はそのまま（_clickIfUnchecked / _clickEl）", /enqueueHumanClick\(cb, _clickEl, 420, 980\)/.test(ps));

console.log("\n■ ③ ITANDI の間取りも毎回ちがう順");
ok("_shuffle がある（Fisher-Yates）", /function _shuffle\(arr\)/.test(ips));
ok("間取りを _shuffle してから tickFloor", /_shuffle\(_ids\)\.forEach\(function \(k\) \{ tickFloor\(k\); \}\)/.test(ips));

console.log("\n■ ④ 間隔に速い固定値が残っていない");
const tooFast = [];
for (const [name, src] of [["page-script.js", ps], ["itandi-page-script.js", ips]]) {
  // enqueueHumanClick / logNormalDelay の引数が 200ms 未満の固定値の物
  for (const m of src.matchAll(/enqueueHumanClick\([^,]+,[^,]+,\s*(\d+),\s*(\d+)\)/g)) {
    if (Number(m[1]) < 300) tooFast.push(`${name}: ${m[0]}`);
  }
}
ok("enqueueHumanClick の下限が 300ms 未満の物が無い", tooFast.length === 0, tooFast.slice(0, 5));
ok("リアプロの打鍵は 165ms/文字", /logNormalDelay\(165, 0\.32\)/.test(ps));
ok("ITANDI のチェックはボタンの意味で間を変える（選択350〜1000ms・決定1200〜3200ms）", /_r = \[350, 1000\]/.test(ips) && /_r = \[1200, 3200\]/.test(ips) && /logNormalDelay\(\(_r\[0\] \+ _r\[1\]\) \/ 2, 0\.32\)/.test(ips));
ok("プルダウンは開く450〜1000・見る700〜1600・確認250〜700", /_ln\(700, 0\.4, 450, 1000\)/.test(ps) && /_ln\(1100, 0\.42, 700, 1600\)/.test(ps) && /_ln\(430, 0\.45, 250, 700\)/.test(ps));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
