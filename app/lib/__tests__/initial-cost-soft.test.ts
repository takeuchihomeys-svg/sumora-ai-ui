// 実行: npx tsx app/lib/__tests__/initial-cost-soft.test.ts
// 2026-10-01 竹内（チンシャン・初回で通す1件）: 「初期費用は安いと嬉しい」（できれば）は減点だけで保留にしない
import { detectLowInitialCostSoft, detectWantsLowInitialCost, buildCustomerProfile, judgeProperty, parsePropertyFacts } from "../property-brain";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note: unknown = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${JSON.stringify(note)}`); } }

// チンシャンさんの other_requests（実物）
const CHIN = "防音性・遮音性の高い物件・駅徒歩は近いと嬉しいが妥協可・初期費用は安いと嬉しい・現在1LDK(家賃8万円)の木造に居住中・騒音クレームを受けて疲れている・今住んでる家が1LDKで家賃8万円です";
t("チンシャン: 初期費用の希望あり・できれば", detectWantsLowInitialCost({ other_requests: CHIN }) && detectLowInitialCostSoft({ other_requests: CHIN }));
t("できれば初期費用を抑えたい → できれば", detectLowInitialCostSoft({ preferences: "できれば初期費用を抑えたい" }));
t("言い切り「初期費用抑えたい」→ できればではない", !detectLowInitialCostSoft({ preferences: "初期費用抑えたい" }));
t("言い切り「敷金礼金なし」→ できればではない", !detectLowInitialCostSoft({ preferences: "敷金礼金なし" }));
t("できれば と 言い切り が両方 → 言い切りが勝つ", !detectLowInitialCostSoft({ preferences: "初期費用は安いと嬉しい", other_requests: "敷金礼金なし必須" }));
t("上限の数字がある → できればではない", !detectLowInitialCostSoft({ preferences: "初期費用は安いと嬉しい", initial_cost_limit: 150000 }));
t("同じ節の別の希望の「嬉しい」は拾わない", !detectLowInitialCostSoft({ other_requests: "駅近だと嬉しい・初期費用抑えたい" }));

// 判定: 敷礼ありの物件（礼金1ヶ月）
const S = "【1】X\n80,000円\n2LDK\n敷金なし 礼金1ヶ月\n徒歩5分";
const soft = judgeProperty(parsePropertyFacts(S), buildCustomerProfile({ rent_max: 100_000, floor_plan: "2LDK", other_requests: CHIN }), 0);
const hard = judgeProperty(parsePropertyFacts(S), buildCustomerProfile({ rent_max: 100_000, floor_plan: "2LDK", preferences: "初期費用抑えたい" }), 0);
t("できれば → INITIAL_COST_NOT_ZERO_SOFT（保留にしない）", soft.reasonCodes.includes("INITIAL_COST_NOT_ZERO_SOFT") && !soft.reasonCodes.includes("INITIAL_COST_NOT_ZERO") && soft.verdict !== "hold", [soft.verdict, soft.reasonCodes]);
t("言い切り → 今まで通り INITIAL_COST_NOT_ZERO で保留", hard.reasonCodes.includes("INITIAL_COST_NOT_ZERO") && hard.verdict === "hold", [hard.verdict, hard.reasonCodes]);
t("できれば は言い切りより点が高い（−5 と −15）", soft.score > hard.score, [soft.score, hard.score]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
