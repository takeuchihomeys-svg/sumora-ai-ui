// app/lib/__tests__/customer-pattern.test.ts
// お客様の型（customer-pattern）と型ごとの足し点（customer-pattern-weights）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/customer-pattern.test.ts
import { customerPatternOf, householdOfLayout, budgetOf, patternKeyOf, conversationPatternOf, isHouseholdType } from "../customer-pattern";
import { householdLayoutOf } from "../star-rank-pickup";
import {
  patternFeatureBits, patternBonusOf, patternBonusOfBits, learnPatternBonusTable, patternGroupKeys, episodeFeatureWin, LEARNABLE_FEATURES,
  ACTIVE_PATTERN_BONUS_TABLE, type PatternEpisode,
} from "../customer-pattern-weights";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}

console.log("■ 間取り → 世帯（一人／二人以上の線は householdLayoutOf と同じ）");
const LAYOUTS = ["1K", "1LDK", "2LDK", "1LDK以上", "1DK以上", "1K、1LDK", "1K・1DK・1LDK", "2LDK〜3LDK", "1LDK〜2LDK", "2DK", "3LDK", "ワンルーム、1LDK", "30平米以上", "", "希望なし", "1R〜1LDK", "2K"];
for (const fp of LAYOUTS) {
  const h = householdOfLayout(fp);
  if (h === "unknown") { t(`${fp || "（空）"} → 不明（householdLayoutOf は false）`, !householdLayoutOf(fp)); continue; }
  t(`${fp} → ${h}（householdLayoutOf ${householdLayoutOf(fp)} と同じ側）`, isHouseholdType(h) === householdLayoutOf(fp));
}
t("1LDK〜2LDK は二人（小さい方）", householdOfLayout("1LDK〜2LDK") === "pair");
t("2LDK〜3LDK は家族", householdOfLayout("2LDK〜3LDK") === "family");
t("1K、1LDK は一人（1K を含む）", householdOfLayout("1K、1LDK") === "single");

console.log("■ 予算の帯");
t("5.5万 → 6万未満", budgetOf(55_000) === "low");
t("6万 → 6〜8万", budgetOf(60_000) === "mid");
t("8万 → 8〜11万", budgetOf(80_000) === "upper");
t("11万 → 11万以上", budgetOf(110_000) === "high");
t("空 → 不明", budgetOf(null) === "unknown");

console.log("■ 条件欄 → 型");
{
  const p = customerPatternOf({ floor_plan: "1K", rent_max: 65_000, initial_cost_limit: 200_000, move_in_time: "いつでも", raw_format_text: "⑦【初期費用の限度額】⇒\n※ 審査に不安な事がある方お気軽に" });
  t("一人×初期費用（初期費用の上限の列）", p.patternKey === "一人×初期費用", p);
  t("フォームの見出し（審査に不安な事がある方）で審査を重視にしない", !p.focus.includes("screening"), p.focus);
  t("いつでも → 未定", p.urgency === "open", p.urgency);
}
{
  const p = customerPatternOf({ floor_plan: "1LDK", rent_max: 120_000, raw_format_text: "⑦【初期費用の限度額】⇒\n⑧【その他ご要望あれば】⇒" });
  t("フォームの見出し「初期費用の限度額」だけでは初期費用にしない", p.patternKey === "二人以上", p);
  t("予算 11万以上", p.budget === "high");
}
{
  const p = customerPatternOf({ floor_plan: "1K", other_requests: "同棲するため。猫飼育可", rent_max: 90_000 });
  t("自由文の「同棲」は間取りより先（二人）", p.household === "pair" && p.householdFrom === "text", p);
  t("猫 → ペット", p.focus.includes("pet") && p.primaryFocus === "pet");
}
{
  const p = customerPatternOf({ floor_plan: "2LDK", other_requests: "大人2人子供2人", ng_points: "1階、木造", preferences: "駅近は絶対" });
  t("子供 → 家族", p.household === "family");
  t("NG 欄2つ＋絶対の節 → 固い", p.firmness === "firm" && p.mustCount === 3, p.mustCount);
}
{
  const p = customerPatternOf({ floor_plan: "1LDK", move_in_time: "即入居", created_at: "2026-10-01T00:00:00Z" });
  t("即入居 → 急ぎ", p.urgency === "urgent");
  const q = customerPatternOf({ floor_plan: "1LDK", move_in_time: "10月中", created_at: "2026-10-01T00:00:00Z" });
  t("登録 10/1 の「10月中」→ 急ぎ（30日以内）", q.urgency === "urgent", q.urgency);
  const r = customerPatternOf({ floor_plan: "1LDK", move_in_time: "12月", created_at: "2026-10-01T00:00:00Z" });
  t("登録 10/1 の「12月」→ ふつう", r.urgency === "normal", r.urgency);
}
t("空の条件 → 不明の型", customerPatternOf(null).patternKey === "不明");
t("patternKeyOf 家族×初期費用 → 二人以上×初期費用", patternKeyOf("family", true) === "二人以上×初期費用");

console.log("■ 会話の軸");
t("送付0 → 新規", conversationPatternOf({ broughtProperties: 0, sentBefore: 0 }).stage === "new");
t("送付あり → 提案中", conversationPatternOf({ broughtProperties: 1, sentBefore: 3 }).stage === "proposing");
t("見積書あり → 深い", conversationPatternOf({ broughtProperties: 0, sentBefore: 3, estimateBefore: true }).stage === "deep");
t("持ち込み2件以上 → 持ち込み型", conversationPatternOf({ broughtProperties: 2, sentBefore: 0 }).bringsOwn);

console.log("■ 特徴の印");
{
  const single = { household: "single" as const }, pair = { household: "pair" as const };
  const bits = patternFeatureBits({ rentRatio: 0.95, areaSqm: 30, buildingAge: 10, walk: 5, zeroZero: 1, adMonths: 2, floor: 3, planMatch: 2, structure: "RC" }, single, { maxArea: 30, minAge: 5, minWalk: 5, maxRent: 0.95, minRent: 0.8 });
  t("上限寄り・敷礼0・駅近・築浅・広い（一人25㎡）・2階以上・RC・束で一番広い・一番駅近・一番家賃が高い", bits.rent_upper === 1 && bits.zero_zero === 1 && bits.walk_near === 1 && bits.age_new === 1 && bits.area_wide === 1 && bits.floor_high === 1 && bits.rc === 1 && bits.area_best === 1 && bits.walk_best === 1 && bits.rent_highest === 1 && bits.age_best === 0, bits);
  t("二人以上の広いは40㎡", patternFeatureBits({ areaSqm: 30 }, pair).area_wide === 0);
  t("分からない値は null（数えない）", patternFeatureBits({}, single).zero_zero === null);
  t("束が無い時は束の比べを付けない", patternFeatureBits({ areaSqm: 30 }, single).area_best === undefined);
}
t("学ぶ特徴に AD・家賃の安さを入れない", !LEARNABLE_FEATURES.includes("ad_high") && !LEARNABLE_FEATURES.includes("rent_low") && !LEARNABLE_FEATURES.includes("rent_lowest"));

console.log("■ 型の鍵と足し点");
{
  const p = customerPatternOf({ floor_plan: "1K", rent_max: 65_000, initial_cost_limit: 200_000 });
  const keys = patternGroupKeys(p, { stage: "deep", bringsOwn: true });
  t("鍵に 型・世帯・予算・段・持ち込み", keys.includes("型:一人×初期費用") && keys.includes("世帯:single") && keys.includes("予算:mid") && keys.includes("段:deep") && keys.includes("持ち込み"), keys);
  const table = { "世帯:single": [{ f: "floor_high" as const, points: 10, n: 20, win: 0.85 }], "全体": [{ f: "floor_high" as const, points: 10, n: 50, win: 0.7 }, { f: "zero_zero" as const, points: 10, n: 30, win: 0.8 }] };
  const b = patternBonusOf(table, keys, p, { floor: 2, zeroZero: 1 });
  t("同じ特徴は1回だけ・上限15", b.points === 15 && b.hits.length === 2, b);
  t("表が無ければ 0", patternBonusOf(null, keys, p, { floor: 2 }).points === 0);
  t("当たらない型は全体だけ", patternBonusOfBits({ "世帯:pair": [{ f: "floor_high", points: 10, n: 20, win: 0.9 }] }, keys, { floor_high: 1 }).points === 0);
  t("本番の表は空（2026-10-06 の当て直しで入れる行なし）", Object.keys(ACTIVE_PATTERN_BONUS_TABLE).length === 0);
}

console.log("■ 学ぶ（型で違う物だけ）");
{
  const mk = (i: number, keys: string[], chosenHas: boolean): PatternEpisode => ({
    id: String(i), at: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`, keys,
    cands: [{ chosen: true, bits: { floor_high: chosenHas ? 1 : 0 } }, { chosen: false, bits: { floor_high: chosenHas ? 0 : 1 } }],
  });
  // 一人は 18/20 で2階以上を選ぶ・二人は 10/20（ランダム）
  const eps = [...Array.from({ length: 20 }, (_, i) => mk(i, ["世帯:single"], i < 18)), ...Array.from({ length: 20 }, (_, i) => mk(100 + i, ["世帯:pair"], i < 10))];
  t("回の中の率（選んだ方が持つ）", episodeFeatureWin(eps[0], "floor_high") === 1 && episodeFeatureWin(eps[19], "floor_high") === 0);
  const table = learnPatternBonusTable(eps, { points: 10 });
  t("一人だけ 2階以上 を学ぶ・二人は学ばない", !!table["世帯:single"]?.some((r) => r.f === "floor_high") && !table["世帯:pair"], table);
  const few = learnPatternBonusTable(eps.slice(0, 10), { points: 10 });
  t("回が少ない（15未満）型は学ばない", !Object.keys(few).length, few);
  const g = learnPatternBonusTable(eps, { points: 10, globalOnly: true });
  t("全員同じの案は「全体」だけ", Object.keys(g).every((k) => k === "全体"), g);
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
