// 実行: node tests/chrome-extension/search-conditions-v2581.test.js
// 2026-10-06 v2.5.81（⑰ の測り直し: 送った60回のうち検索の記録が12時間以内にあったのは15回だけ）:
//   この回の一覧を検索した時の条件を、送る時に回（property_pickups.search_conditions）へ運ぶ＝AIX の文が時刻の窓なしで読める
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const S = require(path.join(dir, "search-stamp.js"));
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }
const NOW = Date.parse("2026-10-06T05:00:00Z");
const stamp = { cid: "c1", name: "あ", at: NOW - 60e3, site: "realpro", complete: true, intended: { area_mode: "station", station_names: ["本町", "堺筋本町"], rent_max: 150000, floor_plan: "1LDK", is_wide: false }, filled: { rent_max: "150000", layouts: ["1LDK"], stations: ["本町", "堺筋本町"] } };
const f = S.forSend(stamp, "c1", NOW);
ok("今のお客様の新しい印 → 条件を運ぶ（v:1・site・at・intended・filled）", f && f.v === 1 && f.site === "realpro" && f.intended.rent_max === 150000 && f.filled.stations.length === 2, f);
ok("別のお客様の印 → 運ばない（別の検索の条件を付けない）", S.forSend(stamp, "c2", NOW) === null);
ok("3時間より前の印 → 運ばない", S.forSend({ ...stamp, at: NOW - 4 * 3600e3 }, "c1", NOW) === null);
ok("印が無い → null", S.forSend(null, "c1", NOW) === null);
const ci = S.compactIntended({ area_mode: "ward", city_codes: ["27114"], station_names: [], rent_max: 65000, floor_plan: "1LDK", customer_name: "けんじじ", ward_town_map: { x: 1 } });
ok("意図した条件は検索の項目だけ（名前・町域の表などは入れない・空は外す）", ci.area_mode === "ward" && ci.city_codes[0] === "27114" && !("station_names" in ci) && !("customer_name" in ci) && !("ward_town_map" in ci), ci);
ok("リアプロ: 検索を押した時に意図した条件と画面に入っていた値を印に", /intended: SS\.compactIntended\(session\.conditions\), filled: readFilledForm\(\)/.test(read("realpro-guide.js")) && /function readFilledForm\(\)/.test(read("realpro-guide.js")));
ok("ITANDI: 検索を押した時に意図した条件と選んだ駅・区のチップを印に", /site: "itandi", complete: true, intended: SS\.compactIntended\(session\.conditions\)/.test(read("itandi-guide.js")));
ok("送る時に印を運ぶ（リアプロ・ITANDI）→ background が merge-pdfs へ", /search_stamp: \(function \(\) \{ var SS/.test(read("bulk-dl.js")) && /search_stamp:        \(function \(\) \{ var SS/.test(read("itandi-bulk-dl.js")) && (read("background.js").match(/search_stamp: +msg\.search_stamp \|\| null/g) || []).length === 2);
const root = path.join(__dirname, "..", "..");
const mp = fs.readFileSync(path.join(root, "app", "api", "merge-pdfs", "route.ts"), "utf8"), ps = fs.readFileSync(path.join(root, "app", "lib", "property-pickups-server.ts"), "utf8"), ms = fs.readFileSync(path.join(root, "app", "api", "migrate-schema", "route.ts"), "utf8");
ok("サーバー: 形が合う時だけ（v:1・8KB まで）回の行の search_conditions に残す・列が無い DB でも記録は残す", /\(body\.search_stamp as \{ v\?: unknown \}\)\.v === 1 && JSON\.stringify\(body\.search_stamp\)\.length <= 8000/.test(mp) && /search_conditions: input\.searchConditions/.test(ps) && /\/search_conditions\/\.test\(ins\.error\.message\)/.test(ps) && /ADD COLUMN IF NOT EXISTS search_conditions JSONB/.test(ms));
ok("manifest の版 2.5.81", JSON.parse(read("manifest.json")).version === "2.5.81");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
