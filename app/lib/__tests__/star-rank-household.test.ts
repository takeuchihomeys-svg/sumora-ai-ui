// 2026-10-06c 🌟（👑）の並べ方: 1LDK以上の間取りを希望するお客様は束の中で一番新しい物に +15（newBuildHousehold）
// 根拠は scripts/audit-star-mismatch-why.ts（物差しを直した束 232回・1LDK以上の型の🌟は一番新しい 60%／ランダム 35%・一人暮らしは 33%／33%）
// 実行: npx tsx app/lib/__tests__/star-rank-household.test.ts
import { rankStarCandidates, starSituationOf, STAR_SITUATION_RULE, STAR_RANK_RULE, STAR_FIT_RULE_TAG, type StarCandidate } from "../recommend-star-rank";
import { householdLayoutOf, starSituationFromConditions, STAR_SITUATION_COLUMNS } from "../star-rank-pickup";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const cand = (key: string, o: Partial<StarCandidate> = {}): StarCandidate => ({ key, codes: [], score: 100, pointsOf: () => 0, adMonths: 2, ...o });

// 間取りの希望の読み（本番の floor_plan の実際の書き方）
t("1LDK → 型", householdLayoutOf("1LDK"));
t("2LDK以上 → 型", householdLayoutOf("2LDK以上"));
t("1LDK〜2LDK → 型", householdLayoutOf("1LDK〜2LDK"));
t("1DK以上 → 型", householdLayoutOf("1DK以上"));
t("全角 ２ＬＤＫ → 型", householdLayoutOf("２ＬＤＫ"));
t("1K → 型でない", !householdLayoutOf("1K"));
t("1K以上 → 型でない（1K を含む）", !householdLayoutOf("1K以上"));
t("1K、1LDK → 型でない（1K を含む＝一人暮らしの型）", !householdLayoutOf("1K、1LDK"));
t("1K.1DK.1LDK → 型でない", !householdLayoutOf("1K.1DK.1LDK"));
t("ワンルーム・1DK → 型でない", !householdLayoutOf("ワンルーム・1DK"));
t("30平米以上（間取りなし）→ 型でない", !householdLayoutOf("30平米以上"));
t("空・null → 型でない", !householdLayoutOf("") && !householdLayoutOf(null));

// 条件欄 → 状況
t("条件欄の列に floor_plan", /\bfloor_plan\b/.test(STAR_SITUATION_COLUMNS));
const s1 = starSituationFromConditions({ floor_plan: "2LDK", preferences: null });
t("条件欄: 2LDK → household", !!s1 && s1.household === true && !s1.zero, s1);
const s2 = starSituationFromConditions({ floor_plan: "1K", initial_cost_limit: 150000 });
t("条件欄: 1K → household でない（初期費用は zero のまま）", !!s2 && s2.household === false && s2.zero, s2);

// 並べ方
const cs = [cand("A", { areaSqm: 45, buildingAge: 25 }), cand("B", { areaSqm: 40, buildingAge: 2 })];
t("型でない → 今まで通り（一番広い A・築年の一番 +8 より広さの一番 +15）", rankStarCandidates(cs, STAR_RANK_RULE, starSituationOf({}))[0].key === "A");
const r = rankStarCandidates(cs, STAR_RANK_RULE, starSituationOf({ household: true }));
t("1LDK以上の型 → 一番新しい B（+15）・理由に出る", r[0].key === "B" && r[0].reasons.some((x) => /1LDK以上/.test(x)), r);
const same = rankStarCandidates([cand("A", { buildingAge: 5 }), cand("B", { buildingAge: 5 })], STAR_RANK_RULE, starSituationOf({ household: true }));
t("束の全部が同じ築年なら全部に付く＝差にならない（順は元の並び）", same[0].key === "A" && same[0].fit === same[1].fit, same);
const unknown = rankStarCandidates([cand("A", { buildingAge: null, score: 101 }), cand("B", { buildingAge: 10 })], STAR_RANK_RULE, starSituationOf({ household: true }));
t("築年が1件しか分からない時は比べない（足さない）", unknown[0].key === "A", unknown);
const line = rankStarCandidates([cand("A", { adMonths: 2, buildingAge: 20 }), cand("B", { adMonths: 1, buildingAge: 1 })], STAR_RANK_RULE, starSituationOf({ household: true }));
t("AD の線は変えない: 線の下の B は合い方 +23（新しい8＋型15）でも差 15 以上なので内覧優先で先頭", line[0].key === "B", line);
t("足し点は 15・決まりの版は 06c", STAR_SITUATION_RULE.newBuildHousehold === 15 && STAR_FIT_RULE_TAG === "star-fit@2026-10-06c");
t("状況なし（null）では足さない", rankStarCandidates(cs)[0].key === "A");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
