// npx tsx scripts/lib/__tests__/worker-assign.test.ts
import assert from "node:assert/strict";
import { workerPlans, workerPlanLines, orderForPick, coreFixOwner, type AssignItem } from "../worker-assign";
import { bucketOfHead } from "../sheet-order";
const now = Date.parse("2026-11-28T00:00:00Z");
const d = (days: number) => new Date(now - days * 86_400_000).toISOString();
const it = (o: Partial<AssignItem> & { id: number }): AssignItem => ({ title: `件${o.id}`, owner: "作業員L", stage: "todo", priority: 1, updated_at: d(0), next_step: "次", switch_name: null, blocker: null, ...o });
// 選び方: priority → building が先 → 古い id
const rows = [it({ id: 900, priority: 0 }), it({ id: 806, priority: 0, stage: "building" }), it({ id: 473, priority: 0, switch_name: "X_ON" }), it({ id: 10, priority: 2 }), it({ id: 11, stage: "done", priority: -5 })];
assert.deepEqual([...rows].filter((r) => r.stage !== "done").sort(orderForPick).map((r) => r.id), [806, 473, 900, 10]);
// 持ち主の読み替え（N2→L）・空の持ち主→統括役・止まっている・次の手が空
const items = [...rows, it({ id: 505, owner: "作業員N2", stage: "building", updated_at: d(5), next_step: "" }), it({ id: 7, owner: null }), it({ id: 8, owner: "作業員A", priority: 0 })];
const plans = workerPlans(items, ["連携が弱い: x → 作業員L", "土台が無い: y → 作業員N", "z → 作業員A", "宛先なし"], now);
const L = plans.find((p) => p.worker === "作業員L")!;
assert.equal(L.open, 5); assert.equal(L.renamed, 1); assert.equal(L.noNext, 1); assert.deepEqual(L.stale.map((x) => x.id), [505]); assert.equal(L.coreFix, 2);
assert.deepEqual(L.next.map((x) => x.id), [806, 473, 900]);
assert.equal(L.dayNext?.id, 806, "スイッチの無い一番上");
assert.equal(plans.find((p) => p.worker === "統括役")?.open, 1);
assert.equal(plans.find((p) => p.worker === "作業員A")?.coreFix, 1);
assert.equal(coreFixOwner("宛先なし"), null);
const lines = workerPlanLines(plans, now);
assert.equal(lines[0], "### 作業員ごとの割り振り（台帳 todo/building・priority の小さい順・LLM なし）");
assert.ok(lines.some((l) => l.startsWith("- 作業員L（開いている 5・止まっている 1・次の手が空 1・持ち主が今いない名前 1・芯の直しの宛先 2）")));
assert.ok(lines.some((l) => l.includes("#473［夜の試験］")));
assert.ok(lines.some((l) => l === "  - 止まっている: #505（5日）"));
assert.equal(bucketOfHead(lines[0]), "conductor");
assert.deepEqual(workerPlanLines([], now), []);
console.log("worker-assign ok 17");
