// app/lib/__tests__/hook-lean-judge.test.ts
// 刺さった新着から学んだ特徴を判定（judgeProperty）に付ける配線（hook-lean-core・hook-lean-server.activeHookLeanTable）と、
// オススメの点（recommend-score）の1位が今の👑（rankStarCandidates の先頭）と同じになることの回帰テスト。
// 実行: npx tsx app/lib/__tests__/hook-lean-judge.test.ts
import { judgeProperty, parsePropertyFacts, buildCustomerProfile, reasonPoints, BASE_SCORE, SCORE_MAX } from "../property-brain";
import { hookLeanCodesOf, hookLeanCode, HOOK_BONUS, type HookLeanTable } from "../hook-lean-core";
import { activeHookLeanTable, hookLeanMode } from "../hook-lean-server";
import { hookLeanBonus as reexported } from "../hooked-arrival-learning";
import { rankStarCandidates, STAR_RANK_RULE, starSituationOf, type StarCandidate } from "../recommend-star-rank";
import { rankByRecommendScore, recommendScores } from "../recommend-score";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}

console.log("■ 学んだ表 → 札（加点だけ・2つまで）");
const table: HookLeanTable = { "二人以上×初期費用": ["age_new"], 全体: ["walk_near", "zero_zero", "rent_upper"] };
const hhInit = { household: true, initial: true };
{
  const codes = hookLeanCodesOf({ rentYen: 95_000, adminFeeYen: 5_000, buildingAge: 8, walkMinutes: 5, depositMonths: 0, keyMoneyMonths: 0 }, 100_000, { table, type: hhInit });
  t("当たる特徴は4つでも札は2つまで（+10 まで）", codes.length === 2 && codes.every((c) => c.startsWith("HOOK_LEAN_")), codes);
  t("型に当たらない特徴（一人）は付かない", hookLeanCodesOf({ buildingAge: 8 }, 100_000, { table: { "二人以上": ["age_new"] }, type: { household: false, initial: false } }).length === 0);
  t("分からない値は付けない（築年なし）", hookLeanCodesOf({ buildingAge: null }, 100_000, { table: { 全体: ["age_new"] }, type: hhInit }).length === 0);
  t("表が無ければ何も付けない", hookLeanCodesOf({ buildingAge: 1 }, 100_000, null).length === 0 && hookLeanCodesOf({ buildingAge: 1 }, 100_000, { table: {}, type: hhInit }).length === 0);
  t("札の点は1つ +5", reasonPoints(hookLeanCode("age_new")) === HOOK_BONUS.bonusEach);
  t("hooked-arrival-learning からも同じ関数", typeof reexported === "function");
}

console.log("■ judgeProperty に渡す");
{
  const today = "2026-10-06";
  const cust = { rent_max: 100_000, floor_plan: "1LDK", preferences: "初期費用を抑えたい" };
  const S = "【1】A 101\n95,000円\n1LDK\n敷なし 礼なし\n○○駅 徒歩5分\n築8年\nAD 2ヶ月";
  const prof = buildCustomerProfile(cust, [], [], null, { today });
  const base = judgeProperty(parsePropertyFacts(S), prof, 0, {});
  const withT = judgeProperty(parsePropertyFacts(S), prof, 0, { hookLean: { table: { 全体: ["age_new"] }, type: hhInit } });
  t("渡さなければ今まで通り（HOOK_LEAN_ の札なし）", !base.reasonCodes.some((c) => c.startsWith("HOOK_LEAN_")));
  t("渡すと築15年以内に HOOK_LEAN_AGE_NEW", withT.reasonCodes.includes("HOOK_LEAN_AGE_NEW"), withT.reasonCodes);
  t("点は +5（上限の内）", withT.score === Math.min(SCORE_MAX, base.score + 5) || withT.score === SCORE_MAX, [base.score, withT.score]);
  t("点＝50＋札の合計", withT.score === Math.min(SCORE_MAX, BASE_SCORE + withT.reasonCodes.reduce((a, c) => a + reasonPoints(c), 0)));
  // 保留（家賃の上限を大きく超える）には付けない
  const held = judgeProperty(parsePropertyFacts("【2】B 202\n160,000円\n1LDK\n敷なし 礼なし\n○○駅 徒歩5分\n築8年\nAD 2ヶ月"), prof, 0, { hookLean: { table: { 全体: ["age_new"] }, type: hhInit } });
  t("保留・外す候補には付けない", held.verdict === "pass" || !held.reasonCodes.includes("HOOK_LEAN_AGE_NEW"), [held.verdict, held.reasonCodes]);
}

console.log("■ 週の学びの記録 → 使ってよい表");
t("proposeUse でない表は使わない", activeHookLeanTable({ ok: true, proposeUse: false, kept: { 全体: ["age_new"] } }) == null);
t("proposeUse でも空なら使わない", activeHookLeanTable({ ok: true, proposeUse: true, kept: {} }) == null);
t("知らない特徴は捨てる", JSON.stringify(activeHookLeanTable({ ok: true, proposeUse: true, kept: { 全体: ["age_new", "xxx"] } })) === JSON.stringify({ 全体: ["age_new"] }));
t("壊れた形は使わない", activeHookLeanTable(null) == null && activeHookLeanTable({ ok: false, proposeUse: true, kept: { 全体: ["age_new"] } }) == null);
t("スイッチ HOOK_LEAN_MODE=off", hookLeanMode("off") === "off" && hookLeanMode(undefined) === "on" && hookLeanMode("") === "on");

console.log("■ オススメの点の1位＝今の👑（rankStarCandidates の先頭）");
const cand = (key: string, o: Partial<StarCandidate> = {}): StarCandidate => ({ key, codes: [], score: 100, pointsOf: () => 0, adMonths: 2, ...o });
const AD2 = { codes: ["AD_HIGH"], pointsOf: (c: string) => (c === "AD_HIGH" ? 22 : 0) };
const cases: Array<[string, StarCandidate[], ReturnType<typeof starSituationOf> | null]> = [
  ["線の上の中で合い方", [cand("a", { score: 122, ...AD2, areaSqm: 30 }), cand("b", { score: 130, ...AD2, areaSqm: 25 })], null],
  ["線の下でも合い方が15以上上なら先頭（内覧を組むのが優先）", [cand("a", { score: 122, ...AD2 }), cand("b", { score: 120, adMonths: null })], null],
  ["線の下で差がちょうど15", [cand("a", { score: 107, ...AD2 }), cand("b", { score: 100, adMonths: null })], null],
  ["線の下で差が14", [cand("a", { score: 108, ...AD2 }), cand("b", { score: 100, adMonths: null })], null],
  ["AD1未満は他に無い時だけ", [cand("a", { score: 200, adMonths: 0.5 }), cand("b", { score: 60, adMonths: null })], null],
  ["線の上が無い時は合い方", [cand("a", { score: 90, adMonths: 1 }), cand("b", { score: 95, adMonths: null })], null],
  ["状況（敷礼0の希望）", [cand("a", { score: 122, ...AD2, zeroZero: false }), cand("b", { score: 120, ...AD2, zeroZero: true })], starSituationOf({ wantTopics: ["zero_deposit"] })],
  ["同点は AD → 敷礼0", [cand("a", { score: 100, adMonths: 1.5, zeroZero: false }), cand("b", { score: 100, adMonths: 1.5, zeroZero: true })], null],
];
for (const [lab, cs, sit] of cases) {
  const f = rankStarCandidates(cs, STAR_RANK_RULE, sit)[0]?.key, u = rankByRecommendScore(cs, sit)[0]?.key;
  t(`${lab}: 👑 ${f}＝オススメの点の1位 ${u}`, f === u, { f, u, scores: recommendScores(cs, sit).map((x) => [x.key, x.score]) });
}
{
  const sc = recommendScores([cand("a", { score: 122, ...AD2, areaSqm: 30 }), cand("b", { score: 100, adMonths: null, areaSqm: 20 })], null);
  const a = sc[0];
  t("内訳の合計＝オススメの点", Math.abs(a.parts.reduce((s, p) => s + p.points, 0) - a.score) < 1e-9, a);
  t("AD の点（+22）は外して線 +15 に", a.parts.some((p) => p.label.startsWith("AD1.5") && p.points === 15) && a.parts[0].points === 100, a.parts);
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
