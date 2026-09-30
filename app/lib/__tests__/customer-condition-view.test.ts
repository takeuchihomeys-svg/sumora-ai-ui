// app/lib/__tests__/customer-condition-view.test.ts
// 売上サポの一番上の「🔎 お客様の条件」とお客様の一覧の条件の行（customer-condition-view.ts）のテスト。
// 実行: npx tsx app/lib/__tests__/customer-condition-view.test.ts
import { customerConditionItems, conditionHeadlineLines, rentValue, latestOverrideLabel, manYen } from "../customer-condition-view";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra !== undefined ? ` -- ${JSON.stringify(extra).slice(0, 300)}` : ""}`); }
}

console.log("── 家賃");
{
  t("7.5万は丸めない", manYen(75000) === "7.5万");
  t("上限だけ", rentValue({ rent_max: 80000 }) === "〜8万円（管理費込み）", rentValue({ rent_max: 80000 }));
  t("下限〜上限", rentValue({ rent_min: 60000, rent_max: 75000 }) === "6万〜7.5万円（管理費込み）");
  t("下限が上限以上なら下限は出さない", rentValue({ rent_min: 80000, rent_max: 80000 }) === "〜8万円（管理費込み）");
  t("無ければ null", rentValue({}) === null);
  // 実物（c46fe3b6 の書き方）: 目安の額は property-brain.readRentTarget と同じ読み取り
  const v = rentValue({ rent_max: 70000, preferences: "共益費込み、できれば60000円程度、独立洗面" });
  t("目安の額（共益費込み）", v === "〜7万円（管理費込み）・目安 6万（共益費込み）", v);
}

console.log("── 行と畳んだ時の行");
{
  const c = { desired_area: "大国町・なんば", rent_min: 60000, rent_max: 80000, floor_plan: "1K〜1LDK", floor_area_min: 25, walk_minutes: 10,
    building_age: 20, move_in_time: "11月中旬", initial_cost_limit: 150000, pet: false, commute_station: "梅田", commute_minutes: 30,
    other_requests: "敷礼なし希望" };
  const rows = customerConditionItems(c);
  t("並び（一覧と同じ）", rows.map((r) => r.key).join(",") === "move_in,area,rent,walk,floor_plan,floor_area,building_age,initial_cost,pet,commute,shikirei", rows.map((r) => r.key));
  t("初期費用", rows.find((r) => r.key === "initial_cost")?.value === "15万円以内");
  t("通勤先", rows.find((r) => r.key === "commute")?.value === "梅田(30分)");
  const h = conditionHeadlineLines(rows);
  t("3行", h.length === 3, h);
  t("1行目 エリア・通勤", h[0] === "📍大国町・なんば・通勤 梅田(30分)", h[0]);
  t("2行目 家賃…", h[1] === "💴6万〜8万円（管理費込み）・1K〜1LDK・25㎡以上・徒歩10分以内・築20年以内", h[1]);
  t("3行目 入居…", h[2] === "入居 11月中旬・初期費用 15万円以内・ペット なし・敷礼なし", h[2]);
  t("空のお客様は行なし", customerConditionItems(null).length === 0 && conditionHeadlineLines([]).length === 0);
  t("古い列（area・layout・max_rent）も読む", customerConditionItems({ area: "天王寺", layout: "1K", max_rent: 70000 }).map((r) => r.value).join("|") === "天王寺|〜7万円（管理費込み）|1K");
}

console.log("── 今回だけの一時調整");
{
  const ov = { command_id: "x", override: { v: 1, location: { mode: "only", stations: ["大正"], lines: [], areas: [] }, floor_plan: "1LDK", rent_max: null, rent_min: null, walk_minutes: null, building_age: null, area_min: null, area_max: null, pet: null, site: null, is_wide: null } };
  t("一時調整あり", latestOverrideLabel([{ search_override: null }, { search_override: ov }]) === "大正駅だけ・1LDK", latestOverrideLabel([{ search_override: ov }]));
  t("無ければ null", latestOverrideLabel([{ search_override: null }]) === null && latestOverrideLabel(undefined) === null);
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
