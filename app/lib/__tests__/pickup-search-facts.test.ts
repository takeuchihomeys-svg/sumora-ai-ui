// app/lib/__tests__/pickup-search-facts.test.ts
// 2026-10-06 ⑰: 物件ピックアップの文に「今回実際に検索した条件」（search_audits.filled.form）を渡す
// 実行: npx tsx app/lib/__tests__/pickup-search-facts.test.ts
import { searchedConditionsFrom, searchedConditionsFromBatch, buildSearchedConditionsNote } from "../pickup-search-facts";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); } }
const now = Date.parse("2026-10-04T04:05:00Z");
// あかりさん（10/04）の形: リアプロ 03:38 西淀川区・5万円以内 → 03:54 6万円（途中で止めた回は数えない）
const rows = [
  { site: "realpro", is_wide: false, created_at: "2026-10-04T03:38:30Z", status: "finished", filled: { form: { age: "-1", walk: "", lines: [], wards: ["大阪市西淀川区"], layouts: [], rent_max: "50000", rent_min: "-1", stations: [] } } },
  { site: "realpro", is_wide: false, created_at: "2026-10-04T03:54:43Z", status: "abandoned", filled: null },
  { site: "itandi", is_wide: false, created_at: "2026-10-04T03:40:00Z", status: "finished", filled: { form: { wards: ["大阪市西淀川区"], rent_max: "60000", layouts: ["1K", "1R"], walk: "10", age: "-1" } } },
  { site: "realpro", is_wide: true, created_at: "2026-10-03T01:00:00Z", status: "finished", filled: { form: { wards: ["大阪市北区"], rent_max: "90000" } } },
];
{
  const c = searchedConditionsFrom(rows, now);
  t("12時間以内に終わった検索だけ（前の日の北区は入れない）", !!c && !c.wards.includes("大阪市北区"), JSON.stringify(c?.wards));
  t("区は両サイトを合わせる（重複なし）", c?.wards.length === 1 && c.wards[0] === "大阪市西淀川区");
  t("家賃の上限は両サイトの大きい方（6万円）", c?.rentMax === 60000);
  t("-1・空は指定なし", c?.rentMin === null && c?.ageMax === null);
  t("間取り・徒歩", c?.layouts.join("・") === "1K・1R" && c?.walkMax === 10);
  t("広げて検索でない", c?.widened === false);
  const note = buildSearchedConditionsNote(c, 7);
  t("生成に渡すブロック: 区・家賃・件数・②は検索した条件と合わせる", note.includes("西淀川区") && note.includes("6万円以内") && note.includes("7件") && note.includes("②のエリア"), note);
}
{
  t("検索の記録が無ければ null・ブロックは空", searchedConditionsFrom([], now) === null && buildSearchedConditionsNote(null) === "");
  const wide = searchedConditionsFrom([{ site: "realpro", is_wide: true, created_at: "2026-10-04T03:00:00Z", status: "finished", filled: { form: { lines: ["阪神本線", "阪神なんば線"], rent_max: "60000" } } }], now);
  t("広げて検索・沿線", wide?.widened === true && buildSearchedConditionsNote(wide).includes("広げて検索") && buildSearchedConditionsNote(wide).includes("阪神本線"));
}
// ── 2026-10-06 ⑯ v2.5.81: 送る束の行の search_conditions（時刻の窓なし）。filled を先に・無ければ intended
{
  const realpro = { search_conditions: { v: 1, site: "realpro", at: "2026-10-06T05:00:00Z", complete: true,
    intended: { ward_names: ["大阪市西淀川区"], rent_max: 65000, floor_plan: "1K", walk_minutes: 10, is_wide: false },
    filled: { rent_min: "", rent_max: "60000", building_age: "", layouts: ["1K", "1R"], city_codes: ["27113"], stations: [] } } };
  const c = searchedConditionsFromBatch([realpro, realpro]);
  t("束: 家賃は filled（画面の値 6万）を intended（6.5万）より先に", c?.rentMax === 60000, JSON.stringify(c));
  t("束: 間取りは filled のラベル", c?.layouts.join("・") === "1K・1R");
  t("束: filled に区の名前が無ければ intended の ward_names", c?.wards.join("・") === "大阪市西淀川区");
  t("束: 徒歩は intended", c?.walkMax === 10);
  const itandi = { search_conditions: { v: 1, site: "itandi", complete: true, intended: { itandi_lines: ["阪神本線"], rent_max: 60000 }, filled: { stations: ["千船", "姫島"], wards: [] } } };
  const c2 = searchedConditionsFromBatch([itandi]);
  t("束（ITANDI）: 駅は filled・沿線は intended・家賃は intended", c2?.stations.join("・") === "千船・姫島" && c2?.lines.join("・") === "阪神本線" && c2?.rentMax === 60000, JSON.stringify(c2));
  t("束の行に search_conditions が無い → null（呼ぶ側は search_audits 12時間へ）", searchedConditionsFromBatch([{ search_conditions: null }, {}]) === null);
  t("中身が空の search_conditions → null", searchedConditionsFromBatch([{ search_conditions: { v: 1, site: "realpro", intended: {}, filled: { rent_max: "", layouts: [] } } }]) === null);
  t("束から作ったブロックにも②の決まり", buildSearchedConditionsNote(c, 5).includes("②のエリア") && buildSearchedConditionsNote(c, 5).includes("6万円以内"));
}
console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
