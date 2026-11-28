// 2026-11-27 作業員L: 現状の把握・進め方の葉 × 出す側（持つ・使う・反映）
// 実行: npx tsx app/lib/__tests__/grasp-linkage.test.ts
import assert from "node:assert/strict";
import { graspCounts, graspGapRank, GRASP_SOURCES, GRASP_LEAF_JA, LEAF_REFLECT, leafDuty } from "../grasp-linkage";

assert.equal(Object.keys(GRASP_LEAF_JA).length, 12, "葉は12");
assert.ok(GRASP_SOURCES.every((s) => s.leaves.every((l) => l in LEAF_REFLECT)));
const rows = [
  { id: "q1", ledger: { property_pickups: [{ row: {} }], sent_properties: [{}] }, pc: { move_in_time: "3月", ai_summary: "要約" }, marks: { pickup_why_pending: 3 }, brain: { now_vs_later: { x: 1 } } },
  { id: "q2", ledger: { property_pickups: [{ row: {} }] }, pc: {}, marks: {}, brain: {} },
];
const cs = graspCounts(rows);
const pk = cs.find((c) => c.source === "property_pickups")!;
assert.deepEqual([pk.has, pk.use, pk.gap, pk.reflect.waiting_for], [2, 1, 1, 1], "持つ 2・使う（印）1・穴 1・待っている物が判断の欄に出た 1");
// 2026-11-27: customer_summary にカルテの印が付いた＝印なしの形は試しの出す側で見る
const NOMARK = [{ id: "t_nomark", name: "印なしの試し", pcField: "ai_summary", marks: [] as string[], leaves: ["substate" as const] }];
const mv = graspCounts(rows, NOMARK).find((c) => c.source === "t_nomark")!;
assert.deepEqual([mv.has, mv.use, mv.noMark], [1, null, true], "印なしは使うが数えられない");
const cv = cs.find((c) => c.source === "customer_summary")!;
assert.deepEqual([cv.has, cv.use, cv.noMark], [1, 0, false], "要約はカルテの印で使うを数える（2026-11-27）");
const mi = cs.find((c) => c.source === "move_in_card")!;
assert.deepEqual([mi.has, mi.use], [1, 0], "入居の札は登録の条件の印（core_cond）で数える");
const g = graspGapRank(cs);
assert.ok(g.every((x) => GRASP_SOURCES.find((s) => s.id === x.source)?.derived !== true), "会話から作る出す側は穴の順に入れない");
assert.ok(g.some((x) => x.source === "property_pickups" && x.kind === "材料に入らない" && x.size === 1));
assert.ok(graspGapRank(graspCounts(rows, NOMARK)).some((x) => x.source === "t_nomark" && x.kind === "印なし（使うが数えられない）"));
// 2026-11-27 作業員A の案: 葉ごとの 持つ・使う・反映（受け持ち表と1つの表）
{
  const ld = leafDuty(GRASP_SOURCES, [{ key: "unanswered_asks", owner: "作業員A", mark: "unanswered" }, { key: "x", owner: "作業員L", mark: null }]);
  assert.equal(ld.length, 12, "葉は12");
  assert.ok(ld.every((d) => d.use.length > 0), `どの葉も使うの印が1つ以上: ${ld.filter((d) => !d.use.length).map((d) => d.leaf).join(",")}`);
  const by = (l: string) => ld.find((d) => d.leaf === l)!;
  assert.ok(by("open_promise").parts.some((p) => p.key === "unanswered_asks") && by("waiting_for").parts.some((p) => p.key === "unanswered_asks"), "印の部品が葉に出る（持ち主つき）");
  assert.ok(ld.every((d) => d.parts.every((p) => p.key !== "x")), "印の無い部品は出ない");
  assert.ok(ld.every((d) => d.holes.every((h) => (h === "持つ" ? !d.hold.length : h === "使う" ? !d.use.length : !d.reflect.length))), "穴は空の段だけ");
}
{ const ld = leafDuty(); const by = (l: string) => ld.find((d) => d.leaf === l)!;
  assert.ok(by("move_in").reflect.includes("after_records") && by("next_line").hold.includes("brain.after_records"), "判断の後の記録で入居の反映と次の LINE の持つが埋まる（作業員A の bf8f1218b）");
  assert.ok(ld.every((d) => !d.holes.length), `穴: ${ld.filter((d) => d.holes.length).map((d) => d.leaf + ":" + d.holes.join("")).join(",")}`); }
console.log("grasp-linkage ok 16");
