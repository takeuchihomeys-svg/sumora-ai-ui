// 2026-11-27 作業員L: 現状の把握・進め方の葉 × 出す側（持つ・使う・反映）
// 実行: npx tsx app/lib/__tests__/grasp-linkage.test.ts
import assert from "node:assert/strict";
import { graspCounts, graspGapRank, GRASP_SOURCES, GRASP_LEAF_JA, LEAF_REFLECT } from "../grasp-linkage";

assert.equal(Object.keys(GRASP_LEAF_JA).length, 12, "葉は12");
assert.ok(GRASP_SOURCES.every((s) => s.leaves.every((l) => l in LEAF_REFLECT)));
const rows = [
  { id: "q1", ledger: { property_pickups: [{ row: {} }], sent_properties: [{}] }, pc: { move_in_time: "3月", ai_summary: "要約" }, marks: { pickup_why_pending: 3 }, brain: { now_vs_later: { x: 1 } } },
  { id: "q2", ledger: { property_pickups: [{ row: {} }] }, pc: {}, marks: {}, brain: {} },
];
const cs = graspCounts(rows);
const pk = cs.find((c) => c.source === "property_pickups")!;
assert.deepEqual([pk.has, pk.use, pk.gap, pk.reflect.waiting_for], [2, 1, 1, 1], "持つ 2・使う（印）1・穴 1・待っている物が判断の欄に出た 1");
const mv = cs.find((c) => c.source === "customer_summary")!;
assert.deepEqual([mv.has, mv.use, mv.noMark], [1, null, true], "印なしは使うが数えられない");
const mi = cs.find((c) => c.source === "move_in_card")!;
assert.deepEqual([mi.has, mi.use], [1, 0], "入居の札は登録の条件の印（core_cond）で数える");
const g = graspGapRank(cs);
assert.ok(g.every((x) => GRASP_SOURCES.find((s) => s.id === x.source)?.derived !== true), "会話から作る出す側は穴の順に入れない");
assert.ok(g.some((x) => x.source === "property_pickups" && x.kind === "材料に入らない" && x.size === 1));
assert.ok(g.some((x) => x.source === "customer_summary" && x.kind === "印なし（使うが数えられない）"));
console.log("grasp-linkage ok 8");
