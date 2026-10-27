// こちらが送った日時・住所の言い直しは「スタッフしか知らない事」に数えない（staff-confirm-facts.isStaffOnlyFactGrounded・STAFF_ONLY_GROUNDED）— 実物の型・LLM なし
// 実行: npx tsx app/lib/__tests__/staff-only-grounded.test.ts
import { findStaffOnlyFact, isStaffOnlyFactGrounded, staffOnlyGroundedEnabled } from "../staff-confirm-facts";
import { confidenceSignals } from "../draft-confidence";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

// 実物の型（watch_turn 8419: AIX【待ち合わせ場所】「11/1 13:00に〇〇 現地エントランスお待ち合わせ」→ 下書き「11/1 13:00 現地でお待ちしております」）
const GROUND = "かしこまりました！！\n11/1（日）ご案内させて頂きます！！\n\n11/1 13:00に〇〇 \n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n住所: 大阪府大阪市生野区田島5丁目21-3";
const DRAFT = "はい😊！！\n11/1 13:00 現地でお待ちしております！！\n何卒よろしくお願い致します！！";
console.log("staff-only-grounded");
it("切替は既定 off", () => { eq(staffOnlyGroundedEnabled({}), false); eq(staffOnlyGroundedEnabled({ STAFF_ONLY_GROUNDED: "on" }), true); });
it("下書きは内覧の確定に当たる（今まで通り）", () => eq(findStaffOnlyFact(DRAFT)?.kind, "viewing_fixed"));
it("同じ日付・時刻をこちらが送っていれば根拠あり", () => eq(isStaffOnlyFactGrounded(findStaffOnlyFact(DRAFT), GROUND), true));
it("違う時刻・材料なしは根拠なし", () => {
  eq(isStaffOnlyFactGrounded(findStaffOnlyFact("11/1 15:00 現地でお待ちしております！！"), GROUND), false);
  eq(isStaffOnlyFactGrounded(findStaffOnlyFact(DRAFT), ""), false);
});
it("「10月28日 17時」の書き方も同じ日時とみる", () => {
  eq(isStaffOnlyFactGrounded(findStaffOnlyFact("10/28（水）17:00のご内覧でお待ちしております😊！！"), "10月28日17時にスプランディッド 現地エントランスお待ち合わせ"), true);
});
it("自信の印: on で根拠のある言い直しは staff_only_fact にしない", () => {
  const sig = () => confidenceSignals({ draft: DRAFT, customerText: "かしこまりました！", groundText: GROUND }).map((s) => s.code);
  delete process.env.STAFF_ONLY_GROUNDED;
  eq(sig().includes("staff_only_fact"), true);
  process.env.STAFF_ONLY_GROUNDED = "on";
  try { eq(sig().includes("staff_only_fact"), false); } finally { delete process.env.STAFF_ONLY_GROUNDED; }
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
