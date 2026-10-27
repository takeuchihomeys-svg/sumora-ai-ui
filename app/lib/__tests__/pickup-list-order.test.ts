// AIX ツール（ピックアップのタブ）の並び（app/lib/pickup-list-order.ts）— 作り物の時刻・DB なし
// 実行: npx tsx app/lib/__tests__/pickup-list-order.test.ts（全 PASS で exit 0）
import { pickupListOrderAt, pickupOrderAnalyzedFirstEnabled } from "../pickup-list-order";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

const CONV = "2026-10-28T01:00:00.000Z", PICK = "2026-10-28T03:00:00.000Z", OLD = "2026-10-27T01:00:00.000Z";
console.log("pickup-list-order");
it("切替は既定 off", () => {
  eq(pickupOrderAnalyzedFirstEnabled({}), false);
  eq(pickupOrderAnalyzedFirstEnabled({ PICKUP_ORDER_ANALYZED_FIRST: "on" }), true);
});
it("off は今まで通り会話の更新（無ければ予備）", () => {
  eq(pickupListOrderAt({ convUpdatedAt: CONV, lastPickupAt: PICK, fallback: OLD }, false), CONV);
  eq(pickupListOrderAt({ convUpdatedAt: null, lastPickupAt: PICK, fallback: OLD }, false), OLD);
});
it("on は解析の方が新しければその時刻・古ければ会話の更新", () => {
  eq(pickupListOrderAt({ convUpdatedAt: CONV, lastPickupAt: PICK, fallback: OLD }, true), PICK);
  eq(pickupListOrderAt({ convUpdatedAt: CONV, lastPickupAt: OLD, fallback: OLD }, true), CONV);
  eq(pickupListOrderAt({ convUpdatedAt: CONV, lastPickupAt: null, fallback: OLD }, true), CONV);
});
it("on で並べると解析した人が一番上", () => {
  const rows = [
    { k: "a", order_at: pickupListOrderAt({ convUpdatedAt: "2026-10-28T02:00:00.000Z", lastPickupAt: null, fallback: OLD }, true) },
    { k: "b", order_at: pickupListOrderAt({ convUpdatedAt: OLD, lastPickupAt: PICK, fallback: OLD }, true) },
  ].sort((x, z) => z.order_at.localeCompare(x.order_at));
  eq(rows.map((r) => r.k), ["b", "a"]);
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
