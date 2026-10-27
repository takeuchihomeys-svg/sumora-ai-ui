// まだ送って頂いていない他の物件の初期費用は見積書にしない（cost-question-estimate の ⑧・COST_Q_OTHER_UNSENT）— 実物の文・LLM なし
// 実行: npx tsx app/lib/__tests__/cost-question-other-unsent.test.ts
import { resolveCostQuestionEstimate, CLEAR_NOT_ESTIMATE_REASONS, type CostQuestionEstimateInput } from "../cost-question-estimate";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

const base: CostQuestionEstimateInput = { turnText: "", turnHasImage: false, turnQuotesOurMessage: false, hoursSinceOurLastPropertySend: 2, estimateSentSinceLastPropertySend: true, customerSentPropertyEarlier: false };
// 実物（試験 q078・9/13）
const Q078 = "ありがとうございます🙇🏻‍♀️՞\n他の不動産が31万だったりしていたので\nちょっとでも安くなるのは嬉しいですし\nびっくりです！一度考えてみます！\n他にも気になっている物件があるので\nそちらも初期費用教えていただきです🙇🏻‍♀️\nよろしいでしょうか？";
const on = (f: () => void) => { process.env.COST_Q_OTHER_UNSENT = "on"; try { f(); } finally { delete process.env.COST_Q_OTHER_UNSENT; } };

console.log("cost-question-other-unsent");
it("off は今まで通り（理由は他の線）", () => {
  delete process.env.COST_Q_OTHER_UNSENT;
  const r = resolveCostQuestionEstimate({ ...base, turnText: Q078 });
  eq(r.reason === "まだ送って頂いていない他の物件", false);
});
it("on: q078 の実物 → 見積書ではない（LLM の見積書送るも外す理由）", () => on(() => {
  const r = resolveCostQuestionEstimate({ ...base, turnText: Q078 });
  eq([r.estimate, r.reason], [false, "まだ送って頂いていない他の物件"]);
  eq(CLEAR_NOT_ESTIMATE_REASONS.has(r.reason), true);
}));
it("on: この番に URL・画像・引用があれば当てない（持ち込み）", () => on(() => {
  eq(resolveCostQuestionEstimate({ ...base, turnText: "他にも気になってる物件があります https://suumo.jp/chintai/x 初期費用教えてください" }).reason === "まだ送って頂いていない他の物件", false);
  eq(resolveCostQuestionEstimate({ ...base, turnText: "他にも気になってる物件です。初期費用いくらですか", turnHasImage: true }).reason === "まだ送って頂いていない他の物件", false);
}));
it("on: 送った物件を指す費用の質問は今まで通り", () => on(() => {
  eq(resolveCostQuestionEstimate({ ...base, estimateSentSinceLastPropertySend: false, turnText: "こちらの初期費用いくらですか？" }).estimate, true);
}));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
