// 見張りの外れ → 試験の自動の正解（scripts/lib/brain-exam-watch.ts）
// 実行: npx tsx scripts/lib/__tests__/brain-exam-watch.test.ts
import { autoAnswerOf } from "../brain-exam-watch";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); } }
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const row = (reason: string, brain: string | null, presses: Array<[string, string | null, boolean]>) => ({
  brain_action: brain, brain_reply_mode: brain ? "aix" : "auto_reply", verdict_detail: { reason },
  staff_aix: presses.map(([aix_type, check_pattern, burst]) => ({ aix_type, check_pattern, burst })),
});
it("ブレインは全力サポート・竹内さんは物件オススメを押した → AIX の種類（正解=押した AIX）", () => {
  eq(autoAnswerOf(row("aix_other", "zenryoku_support", [["property_recommendation", null, true]])), { accept: ["AIX:property_recommendation"], mustNot: ["AIX:zenryoku_support"], type: "AIXの種類" });
});
it("ブレインは返信・スタッフは物件確認した（ピッカーつき）→ 返信か AIX か", () => {
  eq(autoAnswerOf(row("text_but_aix", null, [["property_check_result", "available", true]])), { accept: ["AIX:property_check_result/available", "AIX:property_check_result"], mustNot: ["返信"], type: "返信かAIXか" });
});
it("手打ちの番・2種類押した番・後で押しただけ・内覧後の挨拶は自動にしない", () => {
  eq(autoAnswerOf(row("aix_but_text", "property_send", [])), null);
  eq(autoAnswerOf(row("aix_other", "zenryoku_support", [["property_send", null, true], ["property_recommendation", null, true]])), null);
  eq(autoAnswerOf(row("text_but_aix", null, [["estimate_sheet", null, false]])), null);
  eq(autoAnswerOf(row("text_but_aix", null, [["greeting_viewing", null, true]])), null);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
