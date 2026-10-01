// 費用の語を含むが見積書の場面ではない質問（app/lib/cost-question-kind.ts）
// 実行: npx tsx app/lib/__tests__/cost-question-kind.test.ts
// 材料: 本番のお客様の発言（scripts/audit-cost-question-signal.ts・180日・2026-10-01）。外す形の11通はスタッフが見積書送るを0回押した
import { costQuestionNotEstimate } from "../cost-question-kind";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
it("支払いの時期・方法（手打ちで答えた実物）", () => {
  eq(costQuestionNotEstimate("初期費用の支払いはいつですか？"), "支払いの時期・方法");
  eq(costQuestionNotEstimate("初期費用の支払方法は振込のみですか？ クレカは使えるのでしょうか？"), "支払いの時期・方法");
  eq(costQuestionNotEstimate("こちらを払って翌月から家賃をお支払いしていく形ですか？！"), "支払いの時期・方法");
  eq(costQuestionNotEstimate("初期費用分割は難しいですよね🥲"), "支払いの時期・方法");
});
it("家賃の線の質問", () => {
  eq(costQuestionNotEstimate("家賃をいくらまでにしたら、堺筋本町あたりに物件が出てきますか？"), "家賃の線の質問");
});
it("見積書の場面はそのまま（外さない）", () => {
  eq(costQuestionNotEstimate("初期費用はいくら位になりますかね"), null);
  eq(costQuestionNotEstimate("こちらの３つで一旦お見積もりいただけますか？？"), null);
  eq(costQuestionNotEstimate("こちら初期費用しりたいです！"), null);
  eq(costQuestionNotEstimate("608の初期費用はいくらになるか教えていただけると幸いです"), null);
});
console.log(`\n${passed} passed, ${failed} failed`); if (failed) process.exit(1);
