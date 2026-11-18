/**
 * 実行: npx tsx app/lib/__tests__/itandi-buttons.test.ts
 */
import {
  orderItandiButtonsOneByOne,
  resolveItandiButtonId,
  itandiButtonLabel,
  ITANDI_BUTTONS,
} from "../itandi-buttons";

let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log("  ✓", name);
  else {
    failed++;
    console.log("  ✗", name, detail ?? "");
  }
}

console.log("\n■ ITANDI台帳（作業員B反映）");
ok("件数≥22", ITANDI_BUTTONS.length >= 22, ITANDI_BUTTONS.length);
ok("所在地で絞り込み", resolveItandiButtonId("エリアで絞り込む") === "filter_wards_open");
ok("賃料上限", resolveItandiButtonId("rent:lteq") === "rent:lteq");
ok("間取り", resolveItandiButtonId("間取りチェック") === "room_layout:in");
ok("募集条件更新", resolveItandiButtonId("itandi_update_days") === "offer_conditions_updated_at:gteq");
ok("ペット", resolveItandiButtonId("22010") === "option_id:pet");
ok("検索", resolveItandiButtonId("検索する") === "search");
ok("label", itandiButtonLabel("offer_conditions_updated_at:gteq").includes("更新"));

console.log("\n■ 1つずつ順");
{
  const o = orderItandiButtonsOneByOne(["search", "rent:lteq", "filter_stations_open", "room_layout:in"]);
  ok("絞り込みが検索より前", o.indexOf("search") > o.indexOf("filter_stations_open"), o);
  ok("重複なし", o.length === new Set(o).size);
}

if (failed) {
  console.log("\n失敗:", failed);
  process.exit(1);
}
console.log("\n全部 OK");
