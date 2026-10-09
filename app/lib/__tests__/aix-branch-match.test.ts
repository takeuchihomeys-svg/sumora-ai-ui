// AIX の枝の名前を元の AIX に寄せる（10/08 学習の抜け）
// 実行: npx tsx app/lib/__tests__/aix-branch-match.test.ts
import { aixBranchBase, aixBelongsTo, aixLearnBranchesEnabled } from "../aix-branch-match";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function eq<T>(a: T, b: T, msg = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${msg} got ${x} want ${y}`); }
const BASES = ["property_recommendation", "property_send", "application_push", "property_check_result", "phone_call", "phone_followup"];
it("戻す口", () => { eq(aixLearnBranchesEnabled({}), true); eq(aixLearnBranchesEnabled({ AIX_LEARN_BRANCHES: "off" }), false); });
it("本番の枝の名前を元に寄せる", () => {
  eq(aixBranchBase("property_check_result_available", BASES), "property_check_result");
  eq(aixBranchBase("property_check_result_mgmt_move_in", BASES), "property_check_result");
  eq(aixBranchBase("property_send_new_arrival", BASES), "property_send");
  eq(aixBranchBase("application_push_format", BASES), "application_push");
  eq(aixBranchBase("property_send", BASES), "property_send");
});
it("寄せない: 別の AIX・前の語だけ同じ・空", () => {
  eq(aixBranchBase("proposing", BASES), null);
  eq(aixBranchBase("property_sender", BASES), null, "_ で区切られていない");
  eq(aixBranchBase("phone_followup", BASES), "phone_followup", "phone_call の枝ではない");
  eq(aixBranchBase("", BASES), null); eq(aixBranchBase(null, BASES), null);
});
it("一番長い元に譲る", () => {
  eq(aixBelongsTo("property_send_new_arrival", "property_send", [...BASES, "property_send_new_arrival"]), false);
  eq(aixBelongsTo("property_send_new_arrival", "property_send", BASES), true);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
