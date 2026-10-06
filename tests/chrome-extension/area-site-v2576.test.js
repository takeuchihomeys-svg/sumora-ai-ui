// 実行: node tests/chrome-extension/area-site-v2576.test.js
// 2026-10-06 v2.5.76
//   ① 竹内「地域なのに駅としてなぜか扱っている」（けんじじさん: 希望エリア 東淀川区・旭区・吹田市・守口市・家賃〜6.5万・1LDK〜2LDK）
//      → 市・区で終わる語は駅の辞書にあっても地域（area-token.js）。案内は駅の手順（守口市・吹田）を出さない
//   ② 竹内「itandiで検索したら連動してリアプロも1日となってしまっているので itandi・リアプロそれぞれの更新日にする必要がある」
//      → 手の指定はサイトごとの列（rp_update_days／itandi_update_days・site-update-days.js）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const AT = require(path.join(dir, "area-token.js"));
const SUD = require(path.join(dir, "site-update-days.js"));
const Plan = require(path.join(dir, "realpro-guide-plan.js"));

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

console.log("── ① 市・区の語は地域");
const raw = "大阪市東淀川区・大阪市旭区・吹田市・守口市";
for (const t of ["守口市", "吹田市", "門真市", "寝屋川市", "枚方市", "茨木市", "高槻市", "豊中市", "池田市", "箕面市", "大阪市旭区", "東淀川区"]) {
  ok(`「${t}」は地域（駅にしない）`, AT.isAreaToken(t, raw, null) && !AT.stationEligible(t, raw, null));
}
ok("「守口市駅」と書いてあれば駅", AT.stationEligible("守口市", "守口市駅周辺", null));
ok("路線名つき（京阪守口市・阪急茨木市）は駅", AT.stationEligible("京阪守口市", "京阪守口市", null) && AT.stationEligible("阪急茨木市", "阪急茨木市", null));
ok("スタッフの手直しで駅と覚えた語は駅", AT.stationEligible("守口市", raw, { "守口市": "station" }));
ok("駅の語（吹田・十三・天満）はそのまま駅として拾える", AT.stationEligible("吹田", "吹田", null) && AT.stationEligible("十三", "十三", null) && AT.stationEligible("天満", "天満", null));
const pp = read("popup.js");
ok("popup: 検索の直前の補正（ward→station）は市・区の語を使わない（リアプロ・ITANDI の2か所）", (pp.match(/parseAreaTokens\((?:rawArea|adjAreaClean)\)\.filter\(t => _axStationOk\(t, (?:rawArea|adjAreaClean)\)\)/g) || []).length === 2);
ok("popup: 駅モードの駅の拾い出しも市・区の語を飛ばす（リアプロ・ITANDI）", /if \(!_axStationOk\(part, adjAreaClean\)\) continue;/.test(pp) && /if \(!_axStationOk\(token, rawArea\)\) return;/.test(pp));
ok("resolution-core（一括・background）の駅モードも同じ決まり", /_AT\.isAreaToken\(part, null,/.test(read("resolution-core.js")) && /import "\.\/area-token\.js";/.test(read("background.js")));
ok("popup.html: area-token.js は popup.js より前", (() => { const h = read("popup.html"); return h.indexOf('src="area-token.js"') > 0 && h.indexOf('src="area-token.js"') < h.indexOf('src="popup.js"'); })());
// 地域のお客様の案内は所在地の手順だけ（駅の手順を出さない）
const plan = Plan.buildPlan({ area_mode: "ward", city_codes: ["27114", "27123", "27205", "27213"], station_names: [], rent_max: 65000, floor_plan: "1LDK〜2LDK", rp_update_days: 1 });
const kinds = plan.steps.map((s) => s.kind);
ok("けんじじさんの形: 案内は所在地（pick_city）だけで駅の手順なし", kinds.includes("pick_city") && !kinds.includes("pick_station"), kinds);

console.log("── ② 更新日はサイトごと");
const c = { id: "c1", rp_update_days: 7, itandi_update_days: null };
ok("リアプロの手の指定は rp_update_days", SUD.keyFor("realpro") === "rp_update_days" && SUD.manualFor(c, "realpro") === 7);
ok("ITANDI はリアプロの値を使わない（手の指定なし＝自動）", SUD.manualFor(c, "itandi") === null && SUD.fieldValueFor(c, "itandi", () => 3) === "3");
const p = SUD.patchFor(c, "itandi", "1");
ok("ITANDI で「1日」を選ぶと itandi_update_days だけ書く（rp_update_days は書かない）", p.key === "itandi_update_days" && p.body.itandi_update_days === 1 && !("rp_update_days" in p.body) && p.changed);
const c2 = Object.assign({}, c, { itandi_update_days: 1 });
ok("その後リアプロを開くと今まで通り 7日（ITANDI の 1日が入らない）", SUD.fieldValueFor(c2, "realpro", () => 3) === "7");
ok("「指定なし」は null（自動に戻す）", SUD.patchFor(c2, "itandi", "").next === null);
ok("popup: 欄は今開いているサイトの値・書くのもそのサイトの列", /const _udSite = selectedSite === "itandi" \? "itandi" : "realpro";/.test(pp) && /saveRpUpdateDays\(c, updateDaysEl\.value, _udSite\)/.test(pp) && /body: JSON\.stringify\(p \? p\.body :/.test(pp));
ok("popup.html: site-update-days.js は popup.js より前", (() => { const h = read("popup.html"); return h.indexOf('src="site-update-days.js"') > 0 && h.indexOf('src="site-update-days.js"') < h.indexOf('src="popup.js"'); })());
const ms = fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "migrate-schema", "route.ts"), "utf8");
ok("migrate-schema に itandi_update_days", /ADD COLUMN IF NOT EXISTS itandi_update_days INTEGER/.test(ms));
const mf = JSON.parse(read("manifest.json"));
ok("manifest の版 2.5.78", mf.version === "2.5.78");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
