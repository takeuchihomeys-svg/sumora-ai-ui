// npx tsx scripts/lib/__tests__/free-mem-guard.test.ts
// 2026-11-28 作業員L（流す前の空きメモリの関所・統括役の決め）
import assert from "node:assert/strict";
import { freeMemVerdict, requireFreeMemMb, defaultMinFreeMb } from "../free-mem-guard";
assert.equal(freeMemVerdict(1200, 1000).ok, true);
assert.equal(freeMemVerdict(878, 1000).ok, false, "11/28 夜の 878MB は止める");
assert.equal(defaultMinFreeMb({}), 1000);
assert.equal(defaultMinFreeMb({ L_MIN_FREE_MB: "500" }), 500);
(async () => {
  assert.equal(await requireFreeMemMb(1000, { read: () => 1500 }), 1500);
  await assert.rejects(requireFreeMemMb(1000, { read: () => 469 }), /流さない/, "待たない時は下回ったらすぐ止める");
  const xs = [400, 600, 1100]; let i = 0;
  assert.equal(await requireFreeMemMb(1000, { read: () => xs[i++], waitMin: 1, sleepMs: 1 }), 1100, "待つ間に戻れば流す");
  console.log("free-mem-guard: ok");
})();
