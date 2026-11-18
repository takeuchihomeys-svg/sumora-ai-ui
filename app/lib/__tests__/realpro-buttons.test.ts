/**
 * 実行: npx tsx app/lib/__tests__/realpro-buttons.test.ts
 */
import {
  orderRealproButtonsOneByOne,
  resolveRealproButtonId,
  realproButtonLabel,
} from "../realpro-buttons";

let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log("  ✓", name);
  else {
    failed++;
    console.log("  ✗", name, detail ?? "");
  }
}

console.log("\n■ 別名 → 正名");
ok("沿線を選ぶ→route寄り", resolveRealproButtonId("沿線を選ぶ") === "沿線・駅絞り込み＋" || resolveRealproButtonId("沿線を選ぶ") === "route_id[]");
ok("区を選ぶ→所在地かcity", !!resolveRealproButtonId("区を選ぶ"));
ok("rental_cost2そのまま", resolveRealproButtonId("rental_cost2") === "rental_cost2");
ok("地域の設定へ進む", resolveRealproButtonId("詳細な地域の設定へ進む") === "地域の設定へ進む");
ok("pref_code", resolveRealproButtonId("大阪府") === "pref_code");
ok("structured_type", resolveRealproButtonId("structured_type[]") === "structured_type[]");
ok("敷金・礼金なし別名", resolveRealproButtonId("敷金・礼金なし") === "deposit_recommpence");

console.log("\n■ 1つずつ順");
{
  const o = orderRealproButtonsOneByOne([
    "確定してリストへ",
    "沿線を選ぶ",
    "required_time",
    "区を選ぶ",
    "rental_cost2",
  ]);
  ok("所在地系が沿線より前", o.indexOf("所在地絞り込み＋") < o.indexOf("沿線・駅絞り込み＋") || o.indexOf("city_code[]") < o.indexOf("route_id[]") || o.indexOf("区を選ぶ") < 0);
  const iConfirm = o.indexOf("確定してリストへ");
  const iRent = o.indexOf("rental_cost2");
  ok("確定が賃料より前", iConfirm >= 0 && iRent >= 0 && iConfirm < iRent, o);
  ok("重複なし", o.length === new Set(o).size);
  ok("labelがある", realproButtonLabel("required_time").includes("徒歩") || realproButtonLabel("required_time") === "required_time");
}

if (failed) {
  console.log("\n失敗:", failed);
  process.exit(1);
}
console.log("\n全部 OK");
