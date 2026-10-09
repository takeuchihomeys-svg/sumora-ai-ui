// 申込に届いた会話にも☆（10/08 竹内さん「自動的にする」）
// 実行: npx tsx app/lib/__tests__/auto-star-applied.test.ts
import { autoStarAppliedEnabled, firstAppliedAtByConversation, starEligibleByApply } from "../auto-star-applied";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function eq<T>(a: T, b: T, msg = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${msg} got ${x} want ${y}`); }

it("戻す口: 既定 on・AUTO_STAR_APPLIED=off で旧", () => {
  eq(autoStarAppliedEnabled({}), true); eq(autoStarAppliedEnabled({ AUTO_STAR_APPLIED: "off" }), false);
});
it("最初の申込の時刻は全案件の最小（空・読めない値は無視）", () => {
  const m = firstAppliedAtByConversation([
    { conversation_id: "a", applied_at: "2026-09-20T00:00:00Z" }, { conversation_id: "a", applied_at: "2026-09-01T00:00:00Z" },
    { conversation_id: "b", applied_at: null }, { conversation_id: "c", applied_at: "x" },
  ]);
  eq(m.get("a"), Date.parse("2026-09-01T00:00:00Z")); eq(m.has("b"), false); eq(m.has("c"), false);
});
it("☆の対象: 成約の会話は今まで通り・申込の会話は申込より前の返信だけ", () => {
  const first = new Map([["a", Date.parse("2026-09-10T00:00:00Z")]]);
  const won = new Set(["w"]);
  eq(starEligibleByApply({ conversation_id: "w", created_at: "2026-10-01T00:00:00Z" }, won, first), true);
  eq(starEligibleByApply({ conversation_id: "a", created_at: "2026-09-09T23:00:00Z" }, won, first), true);
  eq(starEligibleByApply({ conversation_id: "a", created_at: "2026-09-10T00:00:00Z" }, won, first), false, "申込の時刻ちょうど以降は入れない");
  eq(starEligibleByApply({ conversation_id: "a", created_at: null }, won, first), false);
  eq(starEligibleByApply({ conversation_id: "z", created_at: "2026-09-01T00:00:00Z" }, won, first), false);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
