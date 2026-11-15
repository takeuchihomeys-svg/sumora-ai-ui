// app/lib/__tests__/sent-like-fit.test.ts — 2026-11-15 作業員K
//   実行: npx tsx app/lib/__tests__/sent-like-fit.test.ts
import { buildSentLikeProfile, sentLikePoints, sentLikeCodes, planTokenOf, sentLikeEnabled } from "../sent-like-fit";
import { rankStarCandidates, STAR_RANK_RULE, starSituationOf, type StarCandidate } from "../recommend-star-rank";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

t("既定 off", !sentLikeEnabled({}) && sentLikeEnabled({ STAR_SENT_LIKE: "on" }));
t("間取りの札", planTokenOf("１ＬＤＫ/30.5㎡") === "1LDK" && planTokenOf("ワンルーム") === "1R" && planTokenOf("2SLDK") === "2LDK" && planTokenOf("") === null);
t("像なし → null", buildSentLikeProfile([]) === null && buildSentLikeProfile([{ from: "customer_sent" }]) === null);
const p = buildSentLikeProfile([
  { floorPlan: "1LDK", areaSqm: 35, ageYears: 5, walk: 6, from: "customer_sent" },
  { floorPlan: "1LDK", areaSqm: 40, ageYears: 10, walk: 8, from: "customer_sent" },
  { floorPlan: "2DK", areaSqm: 42, ageYears: null, walk: null, from: "interested" },
])!;
t("像の中央値", p.n === 3 && p.areaSqm === 40 && p.ageYears === 7.5 && p.walk === 7 && p.plans.includes("1LDK") && p.plans.includes("2DK"));
const hit = sentLikePoints(p, { floorPlan: "1LDK", areaSqm: 38, buildingAge: 8, walkMinutes: 9 });
t("全部似ている → 上限10", hit.points === 10 && hit.reasons.length === 4);
t("似ていない → 0", sentLikePoints(p, { floorPlan: "1K", areaSqm: 20, buildingAge: 30, walkMinutes: 20 }).points === 0);
t("値が無い項目は比べない", sentLikePoints(p, { floorPlan: null, areaSqm: null, buildingAge: null, walkMinutes: null }).points === 0);
const one = buildSentLikeProfile([{ floorPlan: "1LDK", areaSqm: 35, ageYears: 5, walk: 6, from: "customer_sent" }])!;
t("像の元が1件 → 半分（13→7）", sentLikePoints(one, { floorPlan: "1LDK", areaSqm: 35, buildingAge: 5, walkMinutes: 6 }).points === 7);
t("判定の札", sentLikeCodes(p, { floorPlan: "1LDK", areaSqm: 38, buildingAge: 8, walkMinutes: 9 })[0] === "SENT_LIKE_HIGH" && sentLikeCodes(p, { floorPlan: "1LDK" })[0] === "SENT_LIKE_LOW" && sentLikeCodes(null, { floorPlan: "1LDK" }).length === 0);

// 🌟の並べ方: 像があると似た物が上がる・無ければ今まで通り
const pts = () => 0;
const c = (key: string, score: number, floorPlan: string, areaSqm: number): StarCandidate => ({ key, codes: [], score, pointsOf: pts, areaSqm, buildingAge: 10, adMonths: 2, floorPlan, walkMinutes: 5 });
const cands = [{ ...c("A", 80, "1K", 30), buildingAge: 20, walkMinutes: 15 }, c("B", 66, "1LDK", 30)];
const base = starSituationOf({});
t("像なし: A が1位（点が高い）", rankStarCandidates(cands, STAR_RANK_RULE, base)[0].key === "A");
t("像あり: 似た B が1位", rankStarCandidates(cands, STAR_RANK_RULE, { ...base, like: p })[0].key === "B");
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
