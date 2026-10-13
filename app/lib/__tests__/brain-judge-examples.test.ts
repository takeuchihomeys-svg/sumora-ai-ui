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

it("同じ場面だけ・最大3件・同じ一手は1件まで・中身の近い番だけ", () => {
  const all = [
    ex({ customer: "このお部屋まだ空いてますか？募集中ですか", actual: "AIX1" }), ex({ customer: "こちらのお部屋空いてますか 募集中？", actual: "AIX1" }),
    ex({ customer: "このお部屋の空き状況教えてください", actual: "AIX2" }), ex({ customer: "空いてますか？募集は", actual: "AIX3" }), ex({ customer: "空いてる？募集中なら", actual: "AIX4" }),
    ex({ customer: "駐車場ありますか", actual: "AIX5" }),
    ex({ scene: "cost", customer: "初期費用いくら", actual: "AIX6" }),
  ];
  const p = pickJudgeExamples(all, { customerText: "https://suumo.jp/chintai/xxx このお部屋空いてますか？募集中ですか", scene: "property_share" });
  eq(p.length >= 2 && p.length <= 3, true);
  eq(new Set(p.map((x) => x.actual)).size, p.length);
  eq(p.every((x) => x.scene === "property_share" && x.actual !== "AIX5"), true);
});
it("v2: お礼・了承の場面には入れない・一手が返信の手本と内覧後の挨拶は入れない", () => {
  eq(pickJudgeExamples([ex({ scene: "ack", customer: "ありがとうございます", actual: "AIX【物件オススメ】" })], { customerText: "ありがとうございます！", scene: "ack" }).length, 0);
  eq(pickJudgeExamples([ex({ customer: "このお部屋空いてますか", actual: "返信（確認の宣言）" })], { customerText: "このお部屋空いてますか？", scene: "property_share" }).length, 0);
  eq(pickJudgeExamples([ex({ customer: "このお部屋空いてますか", actual: "AIX【内覧後の挨拶（greeting_viewing）】" })], { customerText: "このお部屋空いてますか？", scene: "property_share" }).length, 0);
});
it("同じ会話の番は入れない（conv が同じ）", () => {
  const p = pickJudgeExamples([ex({ conv: "c1", actual: "AIX【物件確認した】" })], { customerText: "このお部屋空いてますか？", conversationId: "c1", scene: "property_share" });
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
it("スイッチ: 既定 on・BRAIN_JUDGE_EXAMPLES=off で戻す", () => {
  eq(judgeExamplesEnabled({ BRAIN_JUDGE_EXAMPLES: "off" }), false);
  eq(judgeExamplesEnabled({}), true);
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
