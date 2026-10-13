// app/lib/__tests__/recommend-appeal-points.test.ts — 🌟の訴求の材料（純関数）
// 実行: npx tsx app/lib/__tests__/recommend-appeal-points.test.ts
import { buildAppealPoints, buildAppealPointsNote, factPhrase, widenedAxesOf, claimContradicts, factContradictions, recommendAppealPointsEnabled } from "../recommend-appeal-points";
import { customerWants } from "../recommendation-gaps";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, info === undefined ? "" : JSON.stringify(info)); } };

// 実物の資料の読み取り（sent_image_properties.facts の形）
const F = { rent: 64000, admin_fee_yen: 5000, floor: 2, area_sqm: 33.95, building_age: 2, walk_minutes: 10, station: "堅苦町", floor_plan: "1LDK", deposit_months: 0, key_money_months: 1 };
const G = { rent: 82000, admin_fee_yen: 4000, floor: 5, area_sqm: 52, building_age: 25, walk_minutes: 4, station: "野崎", floor_plan: "2LDK", deposit_months: 0, key_money_months: 0, equipment: ["独立洗面台", "浴室乾燥機", "オートロック"] };

t("既定 off・on で入る", !recommendAppealPointsEnabled({}) && recommendAppealPointsEnabled({ RECOMMEND_APPEAL_POINTS: "on" }));
{
  const wants = customerWants({ conditions: { building_age: 10, preferences: "独立洗面台・2階以上" } });
  const a = buildAppealPoints(F, wants, { ageMax: 10 });
  t("希望に合う強みを先に（築浅・2階以上）・事実の言い方は資料の値", a.points[0]?.key === "new_build" && a.points[0].fact === "築2年" && a.points.some((p) => p.key === "floor2" && p.fact === "2階"), a.points);
  t("独立洗面台は資料の事実に無い＝強みに出さない（作らない）", !a.points.some((p) => p.key === "washbasin"));
  t("敷礼0 ではない（礼金1ヶ月）＝出さない", !a.points.some((p) => p.key === "zero_deposit"));
}
{
  const a = buildAppealPoints(G, [], {});
  t("希望が無くても一般に強い物（敷礼0 → 駅近4分 → 設備）・築25年は出さない", a.points[0]?.key === "zero_deposit" && a.points.some((p) => p.fact === "野崎駅徒歩4分") && !a.points.some((p) => p.key === "new_build"), a.points);
  t("3つまで", a.points.length <= 3);
}
{
  const wants = customerWants({ conditions: { building_age: 10 } });
  const a = buildAppealPoints(G, wants, { ageMax: 10 });
  t("希望の築10年以内なのに築25年 → 満たさない希望", a.unmet.some((u) => u.key === "new_build"), a.unmet);
  const note = buildAppealPointsNote({ ...a, widened: widenedAxesOf(["AREA_STATION_2STOPS", "SQM_WIDE"]) });
  t("注記: 強み・広げた所・満たさない所・作らない", /刺さる強み/.test(note) && /希望の駅から2駅/.test(note) && /満たさない所/.test(note) && /に無い強みは書かない/.test(note), note);
}
t("新築は築0年だけ・築1年は築浅", factPhrase("new_build", { building_age: 0 }) === "新築" && factPhrase("new_build", { building_age: 1 }) === "築浅（築1年）");
t("注記: 一覧は全部ではない（家賃・広さのいつもの行は書く）と明記", /全部ではない/.test(buildAppealPointsNote({ points: [{ key: "zero_deposit", label: "敷礼0", fact: "敷金礼金なし", why: "general" }], unmet: [], widened: [] })) && /家賃・間取り・広さ/.test(buildAppealPointsNote({ points: [{ key: "zero_deposit", label: "敷礼0", fact: "敷金礼金なし", why: "general" }], unmet: [], widened: [] })));
t("広げた軸は軸ごとに1つ", widenedAxesOf(["AREA_NEAR", "AREA_FAR", "RENT_WIDE"]).length === 2);
t("何も無ければ注記は空", buildAppealPointsNote({ points: [], unmet: [], widened: [] }) === "");
t("事実の言い方: 値が無ければ null", factPhrase("station_near", {}) == null && factPhrase("zero_deposit", { deposit_months: 0, key_money_months: 0 }) === "敷金礼金なし");
t("食い違い: 敷礼なしと書いたが礼金あり", !!claimContradicts("・敷金礼金なし", F) && claimContradicts("・敷金礼金なし", G) == null);
t("食い違い: 新築と書いたが築2年・築浅なら築2年は合う", !!claimContradicts("・新築", F) && claimContradicts("・築浅", F) == null);
t("食い違いの話題: 築25年は築浅でない", factContradictions(G).includes("new_build") && !factContradictions(F).includes("new_build"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
