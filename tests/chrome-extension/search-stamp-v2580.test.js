// 実行: node tests/chrome-extension/search-stamp-v2580.test.js
// 2026-10-06 v2.5.80 竹内「何でこれこんな物件でているのか 原因見つけて改善する 違うお客さんの物件がまぎれている」
//   実際の形: あさん（本町・堺筋本町・〜15万・1LDK）の回に、あさんの条件で検索していない一覧（元付アズ・スタット・1K・江坂/住道/高槻市/芦原橋）の印刷用PDF が付いた
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const S = require(path.join(dir, "search-stamp.js"));
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }
const NOW = Date.parse("2026-10-04T05:11:25Z");
const A = { cid: "4d51caa5", name: "あ" };
// 実際の回: 案内で検索した印が無い（または手順が終わっていない）・選んだ6件のうち4件が遠い
const sel = [{ area: "far" }, { area: "far" }, { area: "far" }, { area: "close" }, { area: "close" }, { area: "far" }];
const r1 = S.check({ stamp: null, cur: A, now: NOW, selected: sel });
ok("実際の回（検索の印なし・6件中4件が遠い）→ 送らずに確かめる", !r1.ok && r1.reasons.includes("no_search") && r1.reasons.includes("far") && /あさん/.test(r1.message), r1);
const r2 = S.check({ stamp: { cid: "b1cfa422", name: "チンシャン", at: NOW - 60e3, complete: true }, cur: A, now: NOW, selected: [] });
ok("別のお客様の検索の一覧 → 送らずに確かめる（誰の検索かを出す）", !r2.ok && r2.reasons.includes("other_customer") && /チンシャンさん/.test(r2.message));
const r3 = S.check({ stamp: { cid: "4d51caa5", name: "あ", at: NOW - 60e3, complete: false }, cur: A, now: NOW, selected: [] });
ok("案内の手順（駅など）が終わる前に押した検索 → 確かめる", !r3.ok && r3.reasons.includes("incomplete"));
const r4 = S.check({ stamp: { cid: "4d51caa5", name: "あ", at: NOW - 4 * 3600e3, complete: true }, cur: A, now: NOW, selected: [] });
ok("3時間以上前の検索の一覧 → 確かめる", !r4.ok && r4.reasons.includes("stale"));
const r5 = S.check({ stamp: { cid: "4d51caa5", name: "あ", at: NOW - 60e3, complete: true }, cur: A, now: NOW, selected: [{ area: "close" }, { area: "far" }, { area: "close" }] });
ok("あさんの検索・手順も終わっている・遠いのは少し → そのまま送る", r5.ok, r5);
const bd = read("bulk-dl.js");
ok("リアプロ: 送る時（手で押す・20秒後のまとめて送る）に確かめる", /if \(sendToLine && !_sendGuardOk\(customerName, customerId\)\) return;/.test(bd));
ok("リアプロ: 20秒後のまとめて送るは、確かめが要る時は送らずボタンに出す", /_autoForwarding = true;/.test(bd) && /確かめが要ります（押して確かめてから送る）/.test(bd));
ok("リアプロ: ブレインの下見の場所（AREA_FAR）を印に", /setAttribute\("data-axlx-area", _codes\.indexOf\("AREA_FAR"\) >= 0 \? "far"/.test(bd));
ok("ITANDI: 送る時に確かめる", /SS\.check\(\{ stamp: SS\.read\(\), cur: \{ cid: customerId, name: customerName \}/.test(read("itandi-bulk-dl.js")));
ok("案内（リアプロ）: 検索を押した時にこの一覧を検索したお客様を印（手順が終わっていたかも）", /SS\.write\(\{ cid: String\(session\.customerId\), name: session\.customerName \|\| "", at: Date\.now\(\), site: "realpro", complete: cur\.step\.kind === "search"/.test(read("realpro-guide.js")));
ok("案内（ITANDI）: 検索を押した時に印", /site: "itandi", complete: true/.test(read("itandi-guide.js")));
const mf = JSON.parse(read("manifest.json"));
ok("manifest: search-stamp.js はリアプロ・ITANDI の案内の段の先頭", mf.content_scripts.filter((c) => c.js[0] === "search-stamp.js").length === 2);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
