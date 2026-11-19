// 実行: node tests/chrome-extension/batch-done-cid-v2827.test.js
// 2.8.127 竹内さん（2026-11-19）「次のお客さんに移る場面のところで固まってしまった」
// 原因の候補（DBの実測＋コード）: 終わりの合図（axlx-batch-customer-done）の番号を終わる時の chrome.storage（current_customer_id）から読んでおり、
//   押している間にお客さんが選び直されると番号が合わず、background は一致する待ちしか解かないので 20〜45分次へ進まなかった。
// 固定する形: 押し始めたお客さんの番号で合図を送る／番号が合わなくても待ちが1本だけなら解く（2本以上なら取り違えないので解かない）。
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");
const bd = read("bulk-dl.js");
const bg = read("background.js");

console.log("■ bulk-dl: 終わりの合図は押し始めたお客さんの番号で送る");
ok("_autoRunCid と _doneCidFrom がある", /var _autoRunCid = null;/.test(bd) && /function _doneCidFrom\(r\) \{[\s\S]{0,200}_autoRunCid[\s\S]{0,200}current_customer_id/.test(bd));
ok("押し始めで番号を控える（最初の1回だけ・ページをまたいでも変えない）", /if \(cid && !_autoRunCid\) _autoRunCid = cid;/.test(bd));
ok("読み直しをまたぐ時は session の印から戻す（Case E）", /if \(s\.customerId\) _autoRunCid = s\.customerId;/.test(bd));
const doneSenders = bd.match(/var cid = _doneCidFrom\(r\);/g) || [];
ok("終わりの合図の2か所（_autoFinish・_sendBatchDone）が控えた番号を使う", doneSenders.length === 2, doneSenders.length);
ok("旧の「その時の storage の番号だけ」で合図を作る所が残っていない（自動の2か所）",
  !/var cid = \(r && r\.current_customer_id\) \|\| null;\s*chrome\.runtime\.sendMessage\(\{\s*type: "axlx-batch-customer-done"/.test(bd));
ok("合図を送ったら控えを捨てる（次のお客さんに持ち越さない）", (bd.match(/_autoRunCid = null;/g) || []).length >= 3);
ok("次の入力が始まって止めた時も控えを捨てる", /_autoPdfRun = null;\s*try \{ _autoRunCid = null; \} catch/.test(bd));

console.log("■ background: 番号が合わなくても待ちが1本だけなら解く");
ok("そのサイトの待ちが1本だけなら解く", /_only\.length === 1[\s\S]{0,600}target = _only\[0\];/.test(bg));
ok("ずれは記録に残す（batch_done_cid_mismatch）", /batch_done_cid_mismatch/.test(bg));
ok("待ちが無い・2本以上は今まで通り解かない（batch_done_no_waiter を記録）", /batch_done_no_waiter/.test(bg) && /return;\s*\/\/ resolve しない・タイムアウト自然消化/.test(bg));
ok("厳密一致を先に探す（一致すればそれを使う・既存の形を保つ）", /厳密一致優先[\s\S]{0,400}String\(_bdw\.customerId\) === String\(customerId\)/.test(bg));

console.log("\n" + passed + " 件 ✓ / " + failed + " 件 ✗");
process.exit(failed ? 1 : 0);
