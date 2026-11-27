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
// 2.8.313: 待ちの間隔は 700〜1000ms の一様乱数 → 対数正規（中央 780ms）＋±30%・420〜1600ms に収める形に変わった（2026-11-17「等間隔 retry をやめ対数正規＋ジッター」・page-script.js _modalRetryMs のコメント）。
//   「人のペースで待つ（≒60秒）」は同じ。間隔が人の速さの範囲（下限〜上限つき）に収まる事を見る。
ok("_modalTry / _modalRetryMs がある", /function _modalTry\(\) \{ return MODAL_TRIES; \}/.test(ps) && (() => {
  const i = ps.indexOf("function _modalRetryMs()"); const j = ps.slice(i).search(/\r?\n  \}\r?\n/) + i;
  const body = i > 0 && j > i ? ps.slice(i, j) : "";
  return /logNormalDelay\(780, 0\.4\)/.test(body) && /if \(v < 420\) v = 420;/.test(body) && /if \(v > 1600\) v = 1600;/.test(body);
})());
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
