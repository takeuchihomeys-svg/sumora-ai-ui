// 実行: node tests/chrome-extension/station-modal-timeout-v267.test.js
// 2026-11-10 竹内さん「駅モーダルで失敗するの原因なにかな？そのような失敗あれば原因を追いかけていく」
//   原因: 沿線・駅モーダルの各段が 30回×500ms＝15秒 で打ち切られ、重い時に「路線一覧が表示されませんでした」で止まっていた
//   ① 待ちを 75回×800ms（±）≒ 60秒 に延ばした
//   ② 失敗したら「その場の画面」を点検に残す（原因を追える）
//   ③ 全件検索は絶対にしない（失敗したら検索しない）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const ps = read("page-script.js");

console.log("■ ① 待ちを延ばした");
ok("MODAL_TRIES は 75", /var MODAL_TRIES = 75;/.test(ps));
ok("_modalTry / _modalRetryMs がある", /function _modalTry\(\) \{ return MODAL_TRIES; \}/.test(ps) && /function _modalRetryMs\(\) \{ return 700 \+ Math\.floor\(Math\.random\(\) \* 300\); \}/.test(ps));
ok("モーダルの4段すべてが _modalTry を使う", (ps.match(/_modalTry\(\), _modalRetryMs\(\)/g) || []).length >= 4);
ok("旧の 30回×500ms が残っていない（モーダルの段）", !/30, 500, \(500 \+ Math\.floor\(Math\.random\(\) \* 500\)\)/.test(ps));

console.log("\n■ ② 失敗したら画面の状態を残す");
ok("station_modal_fail_diag を残す", /_auditStepP\('station_modal_fail_diag'/.test(ps));
ok("モーダルの文字・one_line・駅の入力・絞り込みボタン・キューの長さを見る", /one_line: document\.querySelectorAll\('label\.one_line'\)\.length/.test(ps) && /station_inputs: document\.querySelectorAll\('input\[name="station_id\[\]"\]'\)\.length/.test(ps) && /queue: _clickQueue\.length/.test(ps));
ok("読むだけ（画面を触らない）", !/fallbackSearchWithoutStation[\s\S]{0,900}\.click\(\)/.test(ps));

console.log("\n■ ③ 全件検索はしない");
ok("失敗したら notifyDone で止める", /function fallbackSearchWithoutStation\(msg\)[\s\S]{0,2000}notifyDone\(errMsg\);/.test(ps));
ok("失敗の関数から clickSearch を呼ばない", !/function fallbackSearchWithoutStation[\s\S]{0,2000}clickSearch/.test(ps));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
