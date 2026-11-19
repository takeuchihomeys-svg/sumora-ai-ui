// 実行: node tests/chrome-extension/no-row-check-v2827.test.js
// 2.8.127 竹内さん（2026-11-19）「AIXモードで検索している際、物件ダウンロードする際にチェックボックスにチェックをつけてしまっている。
//   印刷用PDFを押す部分なのに、なぜかチェックボックスにチェックをつける昔のやり方が起きてしまっている」
// 原因: 自動の押下も sendOnePdfNow を通り、そこで無条件に _selectOnly（item.cb.checked = true を直接代入）が走っていた。
// 固定する形: 自動（AIX）の間は行のチェックを付けない／手で押す時は今まで通り（押した1件だけチェック）。
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const bd = fs.readFileSync(path.join(dir, "bulk-dl.js"), "utf8").replace(/\r\n/g, "\n");
const code = bd.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

console.log("■ 自動（AIX）の押下ではチェックを付けない");
ok("_axlxNoRowCheck がある（自動の押下中か、自動の印が立っている間）",
  /function _axlxNoRowCheck\(\) \{[\s\S]{0,200}_autoPdfRun \|\| \(_autoModeOn && !_staffModeOn\)/.test(code));
ok("sendOnePdfNow は _selectOnly を _axlxNoRowCheck の外で呼ぶ（自動では呼ばない）",
  /if \(!_axlxNoRowCheck\(\)\) \{\s*(?:\/\/[^\n]*\n\s*)*_selectOnly\(item\);\s*\}/.test(code));
ok("_selectOnly の呼び出しは sendOnePdfNow の中の1か所だけ（他から直接呼ばない）",
  (code.match(/(?<!function )_selectOnly\(item\)/g) || []).length === 1);

console.log("■ 手で押す時は今まで通り");
ok("_selectOnly は押した1件だけチェック・他の行は外す（2026-11-10 の形）",
  /function _selectOnly\(item\) \{[\s\S]{0,300}t\.cb !== item\.cb && t\.cb\.checked\) t\.cb\.checked = false;[\s\S]{0,200}item\.cb\.checked = true;/.test(code));
ok("送信はチェックに依存しない（押したリンクから1件の組を作る）",
  /function _sendOnePdf\(/.test(code) && /_buildOneItem\(item\.btn\)/.test(code));

console.log("■ 自動の押下の入口は印刷用PDFのリンクを押す（チェックを押さない）");
ok("_pressPrintPdf は btn.click()（印刷用PDF）を押す", /function _pressPrintPdf\(item, cb\)[\s\S]{0,3500}try \{ btn\.click\(\); \}/.test(code));
ok("自動の押下の流れに _humanClickCb（チェックを押す旧の道）が無い",
  !/function _autoPressNext[\s\S]{0,6000}_humanClickCb\(/.test(code));

console.log("\n" + passed + " 件 ✓ / " + failed + " 件 ✗");
process.exit(failed ? 1 : 0);
