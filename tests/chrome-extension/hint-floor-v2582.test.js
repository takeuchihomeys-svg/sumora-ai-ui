// 実行: node tests/chrome-extension/hint-floor-v2582.test.js
// 2026-10-06 v2.5.82（ゆなまるさん: 〜9.5万・徒歩15分・1LDK以上・築30年・40㎡〜・更新7日内）
//   ① 竹内「光っているだけじゃわからない部分はアナウンスを入れる形」②「ここもちゃんと更新日アナウンスいれる」「更新日はお客さんによってちがうから」
//   ③「1LDK以上の場合でこんな5LDKまでえらぶことはない 1LDKから2LDKで調べる」
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
global.AxlxFloorIjou = require(path.join(dir, "floor-ijou.js"));
const FI = global.AxlxFloorIjou;
const RP = require(path.join(dir, "realpro-guide-plan.js"));
const IT = require(path.join(dir, "itandi-guide-plan.js"));
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }
const lab = (vals) => vals.map((v) => RP.FLOOR_LABEL[v] || v);

console.log("── ③ 「〇〇以上」は一つ上の大きさまで");
ok("1LDK以上 → 1LDK・2K・2DK・2LDK（リアプロ・ITANDI 同じ）", JSON.stringify(lab(RP.floorPlanValues("1LDK以上", false))) === '["1LDK","2K","2DK","2LDK"]' && JSON.stringify(IT.layoutIds("1LDK以上", false)) === '["1LDK","2K","2DK","2LDK"]');
ok("1K以上 → 1K・1DK・1LDK", JSON.stringify(lab(RP.floorPlanValues("1K以上", false))) === '["1K","1DK","1LDK"]' && JSON.stringify(IT.layoutIds("1K以上", false)) === '["1K","1DK","1LDK"]');
ok("1DK以上 → 1DK・1LDK", JSON.stringify(IT.layoutIds("1DK以上", false)) === '["1DK","1LDK"]');
ok("2LDK以上 → 2LDK・3K・3DK・3LDK", JSON.stringify(IT.layoutIds("2LDK以上", false)) === '["2LDK","3K","3DK","3LDK"]');
ok("4LDK以上（ITANDI に 5LDK が無い）→ 4LDK・5K以上", JSON.stringify(IT.layoutIds("4LDK以上", false)) === '["4LDK","5K_OVER"]');
ok("短い書き方「1L以上」も同じ", JSON.stringify(IT.layoutIds("1L以上", false)) === '["1LDK","2K","2DK","2LDK"]');
ok("上の決まり: nLDK→(n+1)LDK・nK/nDK→nLDK・1R→1K", FI.ijouUpper("1LDK") === "2LDK" && FI.ijouUpper("2DK") === "2LDK" && FI.ijouUpper("1R") === "1K" && FI.ijouUpper("x") === null);
ok("自動入力（page-script・itandi-page-script）も同じ部品を使う・ページに先に入れる", /_FI\.ijouRange\(FLOOR_RANK, baseFloor\)/.test(read("page-script.js")) && /_FI\.ijouRange\(FLOOR_RANK_IT,/.test(read("itandi-page-script.js")) && /chrome\.runtime\.getURL\("floor-ijou\.js"\)/.test(read("content.js")) && JSON.parse(read("manifest.json")).content_scripts.some((c) => c.world === "MAIN" && c.js.indexOf("floor-ijou.js") === 1));

console.log("── ① ② 値の小さな札（今の手順だけ・光の右に1行）");
const yuna = { rent_max: 95000, walk_minutes: 15, floor_plan: "1LDK以上", building_age: 30, area_min: 40, rp_update_days: 7, station_names: ["天満"], area_mode: "station" };
const rp = RP.buildPlan(yuna);
const hint = (plan, name) => (plan.steps.find((s) => s.name === name) || {}).hint;
ok("リアプロ: 徒歩「15分」・移動手段「徒歩」・賃料「〜9.5万」・面積「40㎡〜」・築年数「30年以内」・更新日「7日以内」", hint(rp, "required_time") === "15分" && hint(rp, "transportation_id") === "徒歩" && hint(rp, "rental_cost2") === "〜9.5万" && hint(rp, "square_meter_l") === "40㎡〜" && hint(rp, "structured_date") === "30年以内" && hint(rp, "update_date") === "7日以内", rp.steps.map((s) => [s.name, s.hint]));
ok("リアプロ: クリックだけの手順（チェック・検索）には札を出さない", rp.steps.filter((s) => s.kind === "check" || s.kind === "search").every((s) => !s.hint));
const it = IT.buildPlan(Object.assign({}, yuna, { itandi_lines: ["大阪環状線"] }));
const itHint = (name) => (it.steps.find((s) => s.name === name) || {}).hint;
ok("ITANDI: 徒歩「15分」・賃料「〜9.5万」・面積「40㎡〜」・築年数「30年以内」", itHint("station_walk_minutes:lteq") === "15分" && itHint("rent:lteq") === "〜9.5万" && itHint("floor_area_amount:gteq") === "40㎡〜" && itHint("building_age:lteq") === "30年以内", it.steps.map((s) => [s.name || s.kind, s.hint]));
// 更新日はお客様ごと・サイトごと（popup の欄＝前回物件を出した日からの日数・新規は14日・サイトごとの手の指定）
const a = { rent_max: 80000, rp_update_days: 3, station_names: ["本町"], area_mode: "station" };
const b = { rent_max: 80000, rp_update_days: 14, station_names: ["本町"], area_mode: "station" };
const aIt = Object.assign({}, a, { rp_update_days: 1 }), bIt = Object.assign({}, b, { rp_update_days: 7 });
const upd = (p) => (p.steps.find((s) => s.name === "update_date" || s.kind === "update_days") || {}).hint;
ok("2人のお客様・2つのサイトで、それぞれの更新日の値を出す（決まった値にしない）", upd(RP.buildPlan(a)) === "3日以内" && upd(RP.buildPlan(b)) === "14日以内" && upd(IT.buildPlan(aIt)) === "1日以内" && upd(IT.buildPlan(bIt)) === "7日以内", [upd(RP.buildPlan(a)), upd(RP.buildPlan(b)), upd(IT.buildPlan(aIt)), upd(IT.buildPlan(bIt))]);
for (const f of ["realpro-guide.js", "itandi-guide.js"]) {
  const s = read(f);
  ok(`${f}: 札は今の手順の値だけ・光の右に小さく1行（灰色）・画面の外の時は出さない`, /highlight\(cur\.ev\.target, cur\.step\.hint \|\| ""\)/.test(s) && /if \(_lastHint && first && !arrow\)/.test(s) && /\.axlx-hint\{position:fixed;pointer-events:none;[^}]*background:#eceff1;/.test(s));
}
ok("manifest の版 2.5.82", JSON.parse(read("manifest.json")).version === "2.5.82");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
