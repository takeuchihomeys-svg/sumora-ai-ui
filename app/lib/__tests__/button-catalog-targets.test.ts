/**
 * 実行: npx tsx app/lib/__tests__/button-catalog-targets.test.ts
 */
import {
  catalogTargetsOnly,
  mapRawToCatalogHint,
  preferKnownWeakTargets,
} from "../button-catalog-targets";

let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log("  ✓", name);
  else {
    failed++;
    console.log("  ✗", name, detail ?? "");
  }
}

console.log("\n■ 値→欄");
ok("1DK→間取り", mapRawToCatalogHint("1DK", "realpro") === "room_layout_id[]");
ok("大阪市北区→区", mapRawToCatalogHint("大阪市北区", "realpro") === "city_code[]");
ok("御堂筋線→沿線", mapRawToCatalogHint("大阪市高速軌道御堂筋線", "realpro") === "route_id[]");

console.log("\n■ 台帳だけ残す");
{
  const t = catalogTargetsOnly(
    ["1DK", "大阪市北区", "確定してリストへ", "ゴミXXX", "route_id[]", "required_time"],
    "realpro",
  );
  ok("1DKが間取りに", t.includes("room_layout_id[]"), t);
  ok("区名がcityに", t.includes("city_code[]"), t);
  ok("確定が残る", t.includes("確定してリストへ"), t);
  ok("ゴミは落ちる", !t.includes("ゴミXXX"), t);
  ok("route残る", t.includes("route_id[]"), t);
}

console.log("\n■ 弱い欄を先頭に");
{
  const t = preferKnownWeakTargets(["required_time"], "realpro");
  ok("駅が先頭付近", t.indexOf("station_id[]") < t.indexOf("required_time"), t.slice(0, 6));
}

if (failed) {
  console.log("\n失敗:", failed);
  process.exit(1);
}
console.log("\n全部 OK");
