// スタッフが送っている途中か（2026-10-28 調べの #5 未来穂）
// 実行: npx tsx app/lib/__tests__/staff-burst.test.ts
import { brainStaffBurstWaitEnabled, staffSendingNow } from "../staff-burst";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const at = (iso: string) => Date.parse(iso);

it("既定 off・on で入る", () => { eq(brainStaffBurstWaitEnabled({}), false); eq(brainStaffBurstWaitEnabled({ BRAIN_STAFF_BURST_WAIT: "on" }), true); });
it("未来穂の形: 17:24:03 にスタッフの1通目・36秒後の下書き作成 → 送っている途中", () => {
  const msgs = [{ sender: "customer", createdAt: "2026-10-22T07:50:00Z" }, { sender: "staff", createdAt: "2026-10-22T08:13:08Z" }, { sender: "staff", createdAt: "2026-10-22T08:24:03Z" }];
  eq(staffSendingNow(msgs, at("2026-10-22T08:24:39Z")), true);
});
it("8分を過ぎた・最後がお客様・時刻が無い → 待たない", () => {
  eq(staffSendingNow([{ sender: "staff", createdAt: "2026-10-22T08:10:00Z" }], at("2026-10-22T08:24:39Z")), false);
  eq(staffSendingNow([{ sender: "staff", createdAt: "2026-10-22T08:24:00Z" }, { sender: "customer", createdAt: "2026-10-22T08:24:30Z" }], at("2026-10-22T08:24:39Z")), false);
  eq(staffSendingNow([{ sender: "staff" }], at("2026-10-22T08:24:39Z")), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
