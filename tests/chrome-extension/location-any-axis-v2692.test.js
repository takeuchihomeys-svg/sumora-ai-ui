// 実行: node tests/chrome-extension/location-any-axis-v2692.test.js
// 2026-11-11 竹内さん「場所あるのに場所ないと誤解している場合おおいのでは。
//   所在地か沿線駅のどちらかで選択していれば場所は指定している。そこの部分誤解されていないか」
//
//   ⚠ 旧は area_mode（希望）で「どちらを求めるか」を決めて、**その軸だけ**を見て
//     「場所が入っていない」と判定していた。area_mode が "ward" でも実際は駅で入る事があるので
//     **場所があるのに「無い」と誤解して止まっていた**。
//   新: 所在地（区・町）か 沿線・駅 の**どちらか1つでも入っていれば場所あり**。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
const G = require(path.join(EXT, "batch-guard.js"));
const ps = read("page-script.js");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

console.log("■ ① どちらか1つでも入っていれば「場所あり」");
{
  const cases = [
    ["区だけ（希望=区）", { area_mode: "ward", city_codes: ["27127"] }, "area"],
    ["区だけ（希望=駅）", { area_mode: "station", city_codes: ["27127"] }, "area"],
    ["区だけ（希望=なし）", { city_codes: ["27127"] }, "area"],
    ["詳細の区だけ", { area_mode: "ward", detail_ward: "大阪市北区" }, "area"],
    ["駅だけ（希望=区）", { area_mode: "ward", station_names: ["梅田"] }, "station"],
    ["駅だけ（希望=駅）", { area_mode: "station", station_names: ["梅田"] }, "station"],
    ["沿線だけ（希望=区）", { area_mode: "ward", route_ids: ["6701"] }, "route"],
    ["沿線だけ（希望=駅）", { area_mode: "station", route_ids: ["6701"] }, "route"],
  ];
  cases.forEach(function (c) {
    const r = G.locationGate(c[1]);
    ok(c[0] + " → 場所あり（" + c[2] + "）", r.ok === true && r.mode === c[2], r);
  });
}

console.log("\n■ ② 両方とも空の時だけ「場所なし」（全件検索を防ぐ）");
{
  const none = [
    ["希望=区で何も無い", { area_mode: "ward" }],
    ["希望=駅で何も無い", { area_mode: "station" }],
    ["希望なしで何も無い", {}],
    ["area という文字だけ（codes が無い）", { area_mode: "ward", areas: ["大阪市北区"] }],
    ["空の配列", { area_mode: "ward", city_codes: [], station_names: [], route_ids: [] }],
  ];
  none.forEach(function (c) {
    const r = G.locationGate(c[1]);
    ok(c[0] + " → 場所なし", r.ok === false && r.mode === "none", r);
  });
}

console.log("\n■ ③ 2つの判定（batch-guard と page-script）が同じ決まり");
{
  ok("page-script は「ward の希望でも駅・沿線なら通す」", /c\.area_mode === "ward"\) \{[\s\S]{0,320}if \(_hasStation\(c\)\) return "station";[\s\S]{0,120}if \(_hasRoutes\(c\)\) return "route";/.test(ps));
  ok("page-script は「station の希望でも区なら通す」", /c\.area_mode === "station"\) \{[\s\S]{0,320}if \(_hasWard\(c\)\) return "area";/.test(ps));
  ok("page-script は 'none' を返す前に3つの軸を全部見る", /_hasWard\(c\)\) return "area";\s*return "none";/.test(ps));
  ok("関所は「区・駅のどちらか入っていれば通す」", /var hasArea = \(wardN > 0\) \|\| \(stN > 0\) \|\| urlHasArea/.test(ps));
  ok("URL に条件が載っていても場所ありとみなす（読み取り失敗の保険）", /urlHasArea/.test(ps));
  ok("どちらで入ったかを点検に残す（area_ok_by）", /out\.area_ok_by =/.test(ps));
  ok("控える areaMode は**実際に入れた軸**（希望ではない）", /areaMode: \(function \(\) \{[\s\S]{0,300}if \(lm === 'area'\) return 'ward';/.test(ps));
}

console.log("\n■ ④ 止めるのは「本当に両方空」の時だけ（場所で止まりすぎない）");
{
  ok("場所のエラー文には区と駅の数を両方出す", /'）が画面に入っていない（区 ' \+ wardN \+ '・駅 ' \+ stN \+ '）'/.test(ps));
  ok("場所で止める分岐はある（全件検索の防止）", /_auditStepP\('gate_stop_area'/.test(ps));
  ok("stall の回復も場所だけ見る", /_areaMissing/.test(ps));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
