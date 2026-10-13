// 判断の手本（app/lib/brain-judge-examples.ts）
// 実行: npx tsx app/lib/__tests__/brain-judge-examples.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { pickJudgeExamples, judgeExamplesBrainText, describeActualMove, textFingerprint, judgeExamplesEnabled, type JudgeExample } from "../brain-judge-examples";
import { JUDGE_EXAMPLES } from "../brain-judge-examples-data";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(actual: T, exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); }

const ex = (o: Partial<JudgeExample>): JudgeExample => ({ conv: "c-other", at: "2026-10-01T00:00:00Z", scene: "property_share", customer: "このお部屋空いてますか？", state: "段階 提案中", brain: "返信", actual: "AIX【物件確認した】", reason: "text_but_aix", writer: "takeuchi", ...o });

it("同じ場面だけ・最大3件・同じ一手は1件まで", () => {
  const all = [
    ex({ customer: "このお部屋まだ空いてますか？", actual: "A1" }), ex({ customer: "こちらの物件空いてますか", actual: "A1" }),
    ex({ customer: "ここ見れますか", actual: "A2" }), ex({ customer: "これどうですか", actual: "A3" }), ex({ customer: "こちらは？", actual: "A4" }),
    ex({ scene: "cost", customer: "初期費用いくら", actual: "B" }),
  ];
  const p = pickJudgeExamples(all, { customerText: "https://suumo.jp/chintai/xxx このお部屋空いてますか？", scene: "property_share" });
  eq(p.length, 3);
  eq(new Set(p.map((x) => x.actual)).size, 3);
  eq(p.every((x) => x.scene === "property_share"), true);
});
it("同じ会話の番は入れない（conv が同じ）", () => {
  const p = pickJudgeExamples([ex({ conv: "c1" })], { customerText: "このお部屋空いてますか？", conversationId: "c1", scene: "property_share" });
  eq(p.length, 0);
});
it("この会話に既に出ている発言の番は入れない（試験の写し・答えが漏れない）", () => {
  const p = pickJudgeExamples([ex({ customer: "千里山のお部屋はまだ募集していますか？内覧したいです" })], {
    customerText: "このお部屋空いてますか？", scene: "property_share", historyCustomerTexts: ["千里山のお部屋はまだ募集していますか？ 内覧したいです😊"],
  });
  eq(p.length, 0);
});
it("元の会話の指紋が今の会話の発言と合えば入れない（先の番の答えが漏れない）", () => {
  const early = "はじめまして、梅田周辺で1LDKを探しています。家賃は10万円までです";
  const p = pickJudgeExamples([ex({ fp: [textFingerprint(early)!] })], { customerText: "このお部屋空いてますか？", scene: "property_share", historyCustomerTexts: [early] });
  eq(p.length, 0);
  eq(textFingerprint("はい"), null);
});
it("材料の文: 手本が無ければ空・あれば場面と一手", () => {
  eq(judgeExamplesBrainText([]), "");
  const t = judgeExamplesBrainText([ex({})]);
  eq(t.includes("【判断の手本"), true);
  eq(t.includes("物件を送ってきた"), true);
  eq(t.includes("竹内さんの実際の一手: AIX【物件確認した】"), true);
});
it("一手の書き方: 押した AIX＞手打ちの AIX の中身＞返信の行為", () => {
  eq(describeActualMove({ burstPress: [{ aix_type: "property_check_result", check_pattern: "available" }], aixJa: { property_check_result: "物件確認した" } }), "AIX【物件確認した（property_check_result）／available】");
  eq(describeActualMove({ burstPress: [], staffFacts: [{ kind: "vacancy", key: "property_check_result/unavailable", family: "確認" }] }).startsWith("AIX の中身"), true);
  eq(describeActualMove({ burstPress: [], staffActs: ["check_promise"], actJa: { check_promise: "確認の宣言" }, laterPress: [{ aix_type: "estimate_sheet" }] }), "返信（確認の宣言）（その後 AIX estimate_sheet）");
});
it("スイッチ: 既定 off・BRAIN_JUDGE_EXAMPLES=on で入れる", () => {
  eq(judgeExamplesEnabled({ BRAIN_JUDGE_EXAMPLES: "off" }), false);
  eq(judgeExamplesEnabled({}), false);
  eq(judgeExamplesEnabled({ BRAIN_JUDGE_EXAMPLES: "on" }), true);
});
it("作った手本: 個人の値（電話・メール）が無い・場面が入っている", () => {
  for (const e of JUDGE_EXAMPLES) {
    if (/0\d{1,3}-?\d{2,4}-?\d{4}|[\w.+-]+@[\w-]+\.[\w.]+/.test(e.customer)) throw new Error(`個人の値: ${e.customer}`);
    if (!e.scene || !e.actual) throw new Error(`欠け: ${JSON.stringify(e).slice(0, 80)}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
