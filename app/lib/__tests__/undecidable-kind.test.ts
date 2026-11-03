// 実行: npx tsx app/lib/__tests__/undecidable-kind.test.ts
import { undecidableKinds } from "../undecidable-kind";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

it("a: 電話・内覧の後で記録が無い", () => { ok(undecidableKinds({ customerText: "先ほどはお電話ありがとうございました" }).includes("a")); ok(!undecidableKinds({ customerText: "先ほどはお電話ありがとうございました", hasRecordOfFact: true }).includes("a")); });
it("b: 管理会社の結果待ち", () => { ok(undecidableKinds({ customerText: "空いてますか", staffText: "管理会社に確認しております" }).includes("b")); });
it("c: スタッフしか知らない数字・AIX の入力", () => {
  ok(undecidableKinds({ customerText: "いつ見れますか", staffText: "11/5 14:00からご案内可能です", draft: "確認させて頂きます" }).includes("c"));
  ok(undecidableKinds({ customerText: "x", aixInput: "募集中" }).includes("c"));
  ok(!undecidableKinds({ customerText: "ありがとうございます", staffText: "かしこまりました", draft: "かしこまりました" }).includes("c"));
});
it("d: あいまい", () => { ok(undecidableKinds({ customerText: "うーん" }).includes("d")); ok(undecidableKinds({ customerText: "ここは空いてますか" }).includes("d")); });
it("e: 交渉・割引", () => { ok(undecidableKinds({ customerText: "家賃の交渉はできますか" }).includes("e")); });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
