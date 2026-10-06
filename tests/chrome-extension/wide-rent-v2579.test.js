// 実行: node tests/chrome-extension/wide-rent-v2579.test.js
// 2026-10-06 v2.5.79（⑫ の決定）家賃の上限が「必ず」（requirement_strength.rent_max.strength=must・KAORI「管理費込みで12万上限」）の時は、
//   広げて検索でも家賃の上限を上げない。エリア・駅・築年数などの広げ方は今まで通り
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const W = require(path.join(dir, "wide-rent.js"));
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const kaori = { rent_max: 120000, requirement_strength: { rent_max: { strength: "must", evidence: "管理費込みで12万上限" } } };
const normal = { rent_max: 120000, requirement_strength: { rent_max: { strength: "prefer" } } };
ok("KAORI（必ず）: 広げても 12万のまま", W.searchRentMax(120000, true, kaori) === 120000);
ok("ふつうのお客様: 広げると 13万（10万超は +1万）", W.searchRentMax(120000, true, normal) === 130000);
ok("10万以下は +5,000円（今まで通り）", W.searchRentMax(70000, true, {}) === 75000);
ok("ピンポイントは足さない", W.searchRentMax(120000, false, normal) === 120000);
ok("requirement_strength が文字列（JSON）で来ても読む", W.rentMust({ requirement_strength: JSON.stringify(kaori.requirement_strength) }));
ok("印が無い・家賃だけ別の項目が must の時は広げる", !W.rentMust({}) && !W.rentMust({ requirement_strength: { floor_plan: { strength: "must" } } }));
const pp = read("popup.js");
ok("popup: リアプロ・ITANDI・指示の表示の3か所で「必ず」なら足さない", (pp.match(/self\.AxlxWideRent && self\.AxlxWideRent\.rentMust\(c\)/g) || []).length === 2 && /const _rentMust = self\.AxlxWideRent \? self\.AxlxWideRent\.rentMust\(c\) : false;/.test(pp));
ok("popup: 築年数の広げ方は今まで通り（+5年）", /searchMode === "wide" \? adjC\.building_age \+ 5 : adjC\.building_age/.test(pp));
ok("resolution-core（一括・background）も同じ決まり・background は印を条件に載せる", /isWide && !_rentMust \? rentNum \+/.test(read("resolution-core.js")) && /requirement_strength: c\.requirement_strength \|\| null,/.test(read("background.js")) && /import "\.\/wide-rent\.js";/.test(read("background.js")));
ok("popup.html: wide-rent.js は popup.js より前", (() => { const h = read("popup.html"); return h.indexOf('src="wide-rent.js"') > 0 && h.indexOf('src="wide-rent.js"') < h.indexOf('src="popup.js"'); })());
ok("manifest の版 2.5.79", JSON.parse(read("manifest.json")).version === "2.5.81");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
