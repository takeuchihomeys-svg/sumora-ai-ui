// 2026-10-14 竹内さん（設計知見 56ecf24a）「自信が無い時だけ深く調べる」— reading-confidence.ts（怪しい印・売上サポとの照らし・読み直しを使うか）
// 実行: npx tsx app/lib/__tests__/reading-confidence.test.ts
import {
  nameSignals, roomSignals, amountUnitSignals, parseAmountText, lookupByAttributes, attrNameFix, cleanPickupName,
  adoptRecheckedName, adoptRecheckedRoom, alignUnitWithPickup, applyRecheckedUnits, markUnitUnclear, readingConfidenceEnabled, type AttrRow,
} from "../reading-confidence";
import { fixReadPropertyName } from "../property-name-fix";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}

console.log("■ 物件名の印（直しの後で見る）");
const known = fixReadPropertyName("エスリード難波", [{ name: "エスリード難波", key: "", marks: "", counts: { text: 1 } }].map((e) => ({ ...e, key: "エスリード難波" })), {});
t("帳簿にある名前は印なし", nameSignals("エスリード難波", { ...known, status: "known" }).length === 0);
t("直した名前は印なし", nameSignals("x", { name: "スプランディッド難波", status: "fixed" }).length === 0);
const un = nameSignals("栄養グランドハイツ", { name: "栄養グランドハイツ", status: "uncertain", candidates: ["栄美グランドハイツ", "栄美グランドハイツII"] });
t("迷った・似た名前が2つ → fix_uncertain・multi_candidates", un.includes("fix_uncertain") && un.includes("multi_candidates"), un);
t("帳簿に無いだけ（新しい物件）は not_in_ledger だけ", JSON.stringify(nameSignals("ラモーナ佃", { name: "ラモーナ佃", status: "unchanged" })) === JSON.stringify(["not_in_ledger"]));

console.log("■ 号室の印");
t("「1K」＝間取りを号室に読んだ", roomSignals("1K").includes("room_plan"));
t("「号室不記載」「不明」", roomSignals("号室不記載").includes("room_text") && roomSignals("不明").includes("room_text"));
t("「5K3」＝数字に英字", roomSignals("5K3").includes("room_letters"));
t("「3077」＝下2桁が40以上", roomSignals("3077").includes("room_tail"));
t("「12345」＝5字以上", roomSignals("12345").includes("room_digits"));
t("階数を超える（11階建ての 3077 は 30階）", roomSignals("3077", { totalFloors: 11 }).includes("room_floor"));
for (const ok of ["302", "1405", "0302", "B-102", "3A", "3-C", "2F-C", "6FA", "A", "2", "", "null"]) t(`普通の号室「${ok}」は印なし`, roomSignals(ok).length === 0, roomSignals(ok));

console.log("■ 敷金・礼金の単位の印");
t("敷金 2（ヶ月）→ 印", amountUnitSignals({ deposit_months: 2 }, {}).includes("deposit_unit"));
t("礼金 1 は印にしない（既定）", amountUnitSignals({ key_money_months: 1 }, {}).length === 0);
t("READING_CONFIDENCE_KEY_MONEY=on で礼金も", amountUnitSignals({ key_money_months: 2 }, { READING_CONFIDENCE_KEY_MONEY: "on" }).includes("key_money_unit"));
t("0・端数・円は印なし", amountUnitSignals({ deposit_months: 0 }, {}).length === 0 && amountUnitSignals({ deposit_months: 1.5 }, {}).length === 0 && amountUnitSignals({ deposit_yen: 20000 }, {}).length === 0);

console.log("■ 欄の文字の単位");
t("2ヶ月", JSON.stringify(parseAmountText("2 ヶ月")) === JSON.stringify({ unit: "months", months: 2 }));
t("2万円", parseAmountText("2万円").yen === 20000);
t("2万円/-（敷引の欄つき）", parseAmountText("2万円/-").yen === 20000);
t("20,000円", parseAmountText("20,000円").yen === 20000);
t("なし・-", parseAmountText("なし").unit === "none" && parseAmountText("-").unit === "none");
t("数字だけ「2」は決めない", parseAmountText("2").unit === "unclear");

console.log("■ 賃料・㎡・間取りで売上サポの建物を探す");
const rows: AttrRow[] = [
  { property_name: "栄美グランドハイツ", room_no: "0302", rent: 62000, area_sqm: 25.1, floor_plan: "1K", total_floors: 5, deposit_months: 0.3, key_money_months: 1 },
  { property_name: "栄美グランドハイツ", room_no: "402", rent: 62000, area_sqm: 25.1, floor_plan: "1K", total_floors: 5, deposit_months: 0.3, key_money_months: 1 },
  { property_name: "別のハイツ", room_no: "101", rent: 70000, area_sqm: 30, floor_plan: "1LDK", total_floors: 3, deposit_months: 1, key_money_months: 1 },
  { property_name: "もう1つのハイツ", room_no: "201", rent: 70000, area_sqm: 30.02, floor_plan: "1LDK", total_floors: 3, deposit_months: 1, key_money_months: 1 },
];
const h = lookupByAttributes(rows, { rent: 62000, areaSqm: 25.12, floorPlan: "1K", room: "302" });
t("1つの建物に決まる・号室も合う", !!h && h.name === "栄美グランドハイツ" && h.sameRoom && h.totalFloors === 5, h);
t("2つの建物にそろう時は決めない", lookupByAttributes(rows, { rent: 70000, areaSqm: 30, floorPlan: "1LDK" }) === null);
t("間取りが違えば当たらない", lookupByAttributes(rows, { rent: 62000, areaSqm: 25.1, floorPlan: "1LDK" }) === null);
t("名前が似ていれば直す（栄養→栄美）", attrNameFix("栄養グランドハイツ", h)?.name === "栄美グランドハイツ");
t("名前が似ていなければ直さない（偶然同じ賃料・㎡の別の建物）", attrNameFix("ヴォーヌング堂ヶ芝", h) === null);
t("区別の印が違えば直さない（II）", attrNameFix("栄美グランドハイツII", h) === null);
t("地名の無い名前は placeless の印", attrNameFix("メゾンフローテ", lookupByAttributes([{ property_name: "メゾンフローラ", room_no: "1", rent: 50000, area_sqm: 20, floor_plan: null }], { rent: 50000, areaSqm: 20 }))?.placeless === true);
t("売上サポの名前の飾りを外す", cleanPickupName("■第2エクセルハイツ") === "第2エクセルハイツ" && cleanPickupName("安立荘(アンリュウソウ)") === "安立荘" && cleanPickupName("Vinoプレジオ本町　2-8F") === "Vinoプレジオ本町");

console.log("■ 読み直しを使うか");
t("読み直した名前が帳簿にある → 使う", adoptRecheckedName({ name: "アーネックス御幣筋本町", status: "uncertain" }, { name: "アーバネックス堺筋本町", status: "known" })?.name === "アーバネックス堺筋本町");
t("読み直しも帳簿に無い → 使わない", adoptRecheckedName({ name: "クリエオーレ津屋Ⅰ", status: "uncertain" }, { name: "クリエオーレー津屋Ⅰ", status: "uncertain" }) === null);
t("同じ名前 → 使わない", adoptRecheckedName({ name: "大幸ロイヤルA4", status: "uncertain" }, { name: "大幸ロイヤルA4", status: "known" }) === null);
t("号室 1K → 403", adoptRecheckedRoom("1K", "403") === "403");
t("号室 3077 → 307（1字の足し引き）", adoptRecheckedRoom("3077", "307") === "307");
t("号室 140 → 1402", adoptRecheckedRoom("140", "1402") === "1402");
t("号室 3077 → 202（まったく別の数）は使わない", adoptRecheckedRoom("3077", "202") === null);
t("読み直しも号室の形でない → 使わない", adoptRecheckedRoom("1K", "1K") === null && adoptRecheckedRoom("不明", "") === null);

console.log("■ 敷金・礼金の単位を決める（①売上サポ ②読み直し ③単位不明の印）");
const p1 = alignUnitWithPickup({ rent: 62000, deposit_months: 2 }, h, h!.key, ["deposit"]);
t("① 同じ部屋の行（0.3ヶ月）＝2万円/賃料 → 20,000円で持つ", p1?.facts.deposit_yen === 20000 && p1.facts.deposit_months === undefined, p1);
t("① 建物が違えば合わせない", alignUnitWithPickup({ rent: 62000, deposit_months: 2 }, h, "べつのたてもの", ["deposit"]) === null);
const p2 = alignUnitWithPickup({ rent: 62000, deposit_months: 1 }, { ...h!, depositMonths: 1 }, h!.key, ["deposit"]);
t("① 同じ月数 → そのまま", p2?.changes.length === 0 && p2.facts.deposit_months === 1);
const r1 = applyRecheckedUnits({ rent: 74000, deposit_months: 2, key_money_months: 1 }, { deposit: "2万円", keyMoney: "10万円" }, ["deposit"], ["key_money"]);
t("② 2万円 → 20,000円（トップヒル森河内）・礼金の 10万円 は数が違うので触らない", r1.facts.deposit_yen === 20000 && r1.facts.key_money_months === 1 && !r1.unclear.length, r1);
const r2 = applyRecheckedUnits({ rent: 74000, deposit_months: 2 }, { deposit: "2ヶ月", keyMoney: "" }, ["deposit"]);
t("② 2ヶ月 → 月数で確か（変えない・印なし）", r2.facts.deposit_months === 2 && !r2.changes.length && !r2.unclear.length);
const r3 = applyRecheckedUnits({ rent: 74000, deposit_months: 2 }, { deposit: "2", keyMoney: "" }, ["deposit"]);
t("② 数字だけ → 決まらない", r3.unclear.includes("deposit"));
const r4 = applyRecheckedUnits({ rent: 74000, deposit_months: 2, key_money_months: 1 }, { deposit: "2ヶ月", keyMoney: "1万円" }, ["deposit"], ["key_money"]);
t("② 礼金も一緒に読んで「1万円」→ 10,000円（印は付けない）", r4.facts.key_money_yen === 10000 && !r4.unclear.length, r4);
const r5 = applyRecheckedUnits({ rent: 74000, deposit_months: 2 }, null, ["deposit"]);
t("② 読み直せなかった → 決まらない", r5.unclear.includes("deposit"));
const m = markUnitUnclear({ deposit_months: 2 }, ["deposit"]);
t("③ 単位不明の印（値は1回目のまま・候補つき）", m.deposit_unit === "unclear" && m.deposit_months === 2 && JSON.stringify(m.deposit_unit_candidates) === JSON.stringify(["2ヶ月", "2万円"]), m);

console.log("■ 戻す");
t("READING_CONFIDENCE=off", readingConfidenceEnabled({ READING_CONFIDENCE: "off" }) === false && readingConfidenceEnabled({}) === true);

console.log(`\n${passed} passed / ${failed} failed`);
if (failed) process.exit(1);
