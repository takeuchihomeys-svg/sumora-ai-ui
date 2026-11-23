// npx tsx app/lib/__tests__/batched-cull.test.ts
// 2026-11-23 作業員N2（台帳 #656）: 多い行の書き換えを少しずつ・時間の上限で止める・失敗しても済んだ分は残る
import assert from "node:assert/strict";
import { cullInBatches } from "../batched-cull";

(async () => {
  // 450行を 200 ずつ → 3回（200・200・50）で全部
  let left = Array.from({ length: 450 }, (_, i) => `id${i}`);
  const io = { pick: async (n: number) => left.slice(0, n), reject: async (ids: string[]) => { left = left.filter((x) => !ids.includes(x)); return ids.length; } };
  const r = await cullInBatches(io, { batch: 200, budgetMs: 60_000 });
  assert.deepEqual([r.picked, r.rejected, r.batches, r.more, r.error], [450, 450, 3, false, null]);

  // 時間の上限で止める（残りは次の週）
  left = Array.from({ length: 1000 }, (_, i) => `id${i}`);
  let t = 0;
  const r2 = await cullInBatches(io, { batch: 100, budgetMs: 250, now: () => (t += 100) });
  assert.equal(r2.more, true);
  assert.ok(r2.rejected > 0 && r2.rejected < 1000);

  // 途中で失敗しても済んだ分の数は返す
  left = Array.from({ length: 500 }, (_, i) => `id${i}`);
  let k = 0;
  const r3 = await cullInBatches({ pick: io.pick, reject: async (ids) => { if (++k === 2) throw new Error("statement timeout"); return io.reject(ids); } }, { batch: 200, budgetMs: 60_000 });
  assert.deepEqual([r3.rejected, r3.batches, r3.error], [200, 2, "statement timeout"]);

  // 選ぶ物が無ければ何もしない
  left = [];
  assert.deepEqual(await cullInBatches(io, { batch: 200, budgetMs: 60_000 }), { picked: 0, rejected: 0, batches: 0, more: false, error: null });
  // 選ぶのは1回だけ・上限まで選んだら残りがある印
  left = Array.from({ length: 30 }, (_, i) => `id${i}`);
  let picks = 0;
  const r4 = await cullInBatches({ pick: async (n) => { picks++; return io.pick(n); }, reject: io.reject }, { batch: 10, budgetMs: 60_000, maxTotal: 20 });
  assert.deepEqual([picks, r4.rejected, r4.more], [1, 20, true]);
  console.log("batched-cull: ok");
})().catch((e) => { console.error(e); process.exit(1); });
