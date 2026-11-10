// 実行: node tests/chrome-extension/no-freeze-v268.test.js
// 2026-11-10 竹内さん「途中でマウスとまったりしている／止まったまま動いていないなぜなのか」
//   原因: 迷いの漂い（drift/wander）の間、タイマーも列も空に見えて「暇」と誤判定され、
//         次の段と重なって、迷いが終わった側が次の列を起こさず止まっていた
//   ① 処理中の1件も「忙しい」に数える
//   ② 列が20秒進まない時の安全弁で強制的に次へ
//   ③ 点検に「いま処理中の物」を残す（止まった場所が分かる）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const ps = read("page-script.js");

console.log("■ ① 処理中の1件も「忙しい」");
ok("_clickBusyItem を宣言", /var _clickBusyItem = null;/.test(ps));
ok("列から取り出したら処理中にする", /var item = _clickQueue\.shift\(\);\s*_clickBusyItem = item;/.test(ps));
ok("終わったら処理中を消す", /_clickBusyItem = null;\s*_clickQueueTimer = null;\s*_scheduleClickDrain\(\);/.test(ps));
ok("isClickQueueBusy が処理中も数える", /return _clickQueueTimer !== null \|\| _clickQueue\.length > 0 \|\| !!_clickBusyItem \|\| _holdingPause;/.test(ps));
ok("迷いの漂いの間でも列を二重に起こさない", /if \(_clickQueueTimer \|\| _clickBusyItem \|\| !_clickQueue\.length\) return;/.test(ps));

console.log("\n■ ② 安全弁（20秒進まない時に強制）");
ok("setInterval 3000 の安全弁がある", /setInterval\(function \(\) \{[\s\S]{0,1200}クリックの列が20秒進まない → 強制的に次へ/.test(ps));
ok("止まった所のラベルを出す", /固まった所: ' \+ cur \+/.test(ps));
ok("処理中の印も外す", /if \(_clickBusyItem\.el\) _clickBusyItem\.el\.__axPending = false;/.test(ps));
ok("clearClickQueue が処理中も消す", /_clickBusyItem = null;\s*if \(_clickQueueTimer\) \{ clearTimeout\(_clickQueueTimer\); _clickQueueTimer = null; \}/.test(ps));

console.log("\n■ ③ 点検に「いま処理中の物」");
ok("stall に queue_busy_item を残す", /queue_busy_item: \(_clickBusyItem && _clickBusyItem\.label\) \|\| null/.test(ps));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
