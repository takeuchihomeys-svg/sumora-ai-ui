// 実行: node tests/chrome-extension/move-then-click-v2613.test.js
// 2026-11-10 竹内さん「マウスが動く前に選択されてしまう場合がある／マウスが動いてそこから押す／この人間の流れをちゃんとおこなう」
//   ① _humanClick は「押し終わるまで」待てる Promise を返す（迷いの間も解決しない）
//   ② ITANDI の駅は1つずつ「着いて押す」のを待ってから次へ（40〜100ms の連打をやめた）
//   ③ 「全域」を押した後は、チェックが入るのを待ってから次の駅へ
//   ④ 町域は1つずつ押して、全部済んでから確定する
//   ⑤ リアプロの一覧も1件選んで送ってから次を選ぶ
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const ips = read("itandi-page-script.js");
const bd = read("bulk-dl.js");

console.log("■ ① _humanClick は押し終わるまで待てる");
ok("押した後に resolve する Promise を返す", /var clicked = new Promise\(function \(resolve\) \{[\s\S]{0,1200}resolve\(true\)/.test(ips));
ok("迷いの間も解決しない（doneClick の後だけ resolve）", /var doneClick = function \(\) \{[\s\S]{0,300}resolve\(true\); \};/.test(ips));
ok("旧の afterMove（迷いの間だけ待たない）が残っていない", !/var afterMove = function \(\)/.test(ips));

console.log("\n■ ② 駅は1つずつ「着いて押す」のを待つ");
ok("40〜100ms の連打が無い", !/setTimeout\(clickNext, 40 \+ Math\.floor\(Math\.random\(\) \* 60\)\)/.test(ips));
ok("clickNext は Promise の後に人の間（420〜1100ms）", /var p = _humanClick\(inp, \{ forceUnchecked: true \}\);[\s\S]{0,400}var _nextGap = 420 \+ Math\.floor\(Math\.random\(\) \* 680\);/.test(ips));
ok("たまに一息（10%）", /if \(Math\.random\(\) < 0\.1\) _nextGap \+= 500 \+ Math\.floor\(Math\.random\(\) \* 900\);/.test(ips));

console.log("\n■ ③ 全域の後はチェックが入るのを待つ");
ok("_humanClick の Promise を待つ", /var _pAll = _humanClick\(allInp, \{ forceUnchecked: true \}\);/.test(ips));
ok("チェックが入るまで最大12回見る", /_waitChecked[\s\S]{0,300}n >= 12/.test(ips));

console.log("\n■ ④ 町域は1つずつ押して全部済んでから確定");
ok("順番に押す _clickTownNext がある", /function _clickTownNext\(\)/.test(ips));
ok("全部済んでから safeConfirm", /_tIdx >= _townClicks\.length[\s\S]{0,300}safeConfirm/.test(ips));
ok("1つずつ Promise を待つ", /var p2 = _humanClick\(lbl2\);/.test(ips));

console.log("\n■ ⑤ リアプロの一覧も1件選んで送ってから次");
ok("_oneByOneStart がある", /function _oneByOneStart\(state, list, index, doneCb\)/.test(bd));
ok("前の行のチェックを外す（1件だけ選ぶ）", /tracked\.forEach\(function \(t\) \{ if \(t\.cb && t\.cb !== item\.cb && t\.cb\.checked\) t\.cb\.checked = false; \}\)/.test(bd));
ok("送り終わってから次を選ぶ", /_doSendOne\(item, state, function \(\) \{[\s\S]{0,300}_oneByOneStart\(state, list, index \+ 1, doneCb\)/.test(bd));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
