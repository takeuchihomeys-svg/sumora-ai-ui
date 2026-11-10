// 実行: node tests/chrome-extension/look-before-act-v2610.test.js
// 2026-11-10 竹内さん「ちゃんと画面を見ながら動くようにしていく。そうすれば理数の形となっていく」
//   「ここの部分リアプロもITANDIもちゃんとできるように徹底していく」
//   ① 操作する前に「その欄が画面に出ているか」を確かめる（見えなければ待って見直す）
//   ② リアプロ・ITANDI の両方に入っている
//   ③ ITANDI の入力欄も「カーソル→見る→押す→1文字ずつ」
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const ps = read("page-script.js");
const ips = read("itandi-page-script.js");

console.log("■ ① 見えているかを確かめてから操作");
ok("リアプロ: waitVisible が最大12回（6秒）見直す", /if \(ok \|\| attempt >= 12\) \{ resolve\(true\); return; \}/.test(ps));
ok("リアプロ: 動かす前に waitVisible を通る", /return waitVisible\(0\)\.then\(function \(\) \{\s*return P\.moveToEl\(el\);/.test(ps));
ok("ITANDI: waitVisible が最大12回見直す", /if \(ok \|\| attempt >= 12\) \{ done\(\); return; \}/.test(ips));
ok("ITANDI: カーソルを動かしてから waitVisible", /P\.moveToEl\(el\)\.then\(function \(\) \{[\s\S]{0,200}waitVisible\(0, function \(\) \{ setTimeout\(type, look\); \}\)/.test(ips));
ok("見えなくても止まらない（最後は触る）", /if \(ok \|\| attempt >= 12\)/.test(ps) && /if \(ok \|\| attempt >= 12\)/.test(ips));

console.log("\n■ ② ITANDI の入力欄も人らしく");
ok("_itTypeIntoHuman がある", /function _itTypeIntoHuman\(el, val\)/.test(ips));
ok("欄を押してから入力する", /\["mousedown", "mouseup", "click"\]\.forEach\(function \(t\)/.test(ips));
ok("1文字ずつ打つ（setReactVal 経由）", /var p = setReactVal\(el, val\);/.test(ips));
ok("賃料・下限賃料・面積・徒歩・築年数が _itTypeIntoHuman", (ips.match(/_itTypeIntoHuman\(/g) || []).length >= 6);
ok("旧の即入力（setReactVal 直呼び）が残っていない", !/if \(rentEl\) \{ setReactVal\(rentEl/.test(ips) && !/if \(areaMinEl\) setReactVal/.test(ips));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
