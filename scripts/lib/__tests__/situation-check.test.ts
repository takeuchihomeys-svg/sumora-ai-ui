// npx tsx scripts/lib/__tests__/situation-check.test.ts
// 2026-11-23 作業員L（台帳 #17）: 現状把握の物差し（根 situation:match）の純関数
import assert from "node:assert/strict";
import { situationMissOf, situationFieldsOf, situationTurns, buildSituationTree, truthOpenPromises, truthTimedViewings, SITUATION_MAP_ROOT } from "../situation-check";

assert.equal(situationMissOf(2, 2), "ok");
assert.equal(situationMissOf(1, 2), "under");
assert.equal(situationMissOf(3, 1), "over");
assert.deepEqual(situationFieldsOf({ po: 2, tv: 1, se: 9 }), { po: 2, tv: 1 });
assert.deepEqual(situationFieldsOf(null), {});
// 実物の開いている約束: 判断の時刻より後に閉じた約束は、その時点では開いていた
const at = Date.parse("2026-11-22T05:35:00Z");
const facts = [
  { kind: "pickup_declared", status: "promised", sent_at: "2026-11-21T06:19:00Z", detail: { closed_by: { sent_at: "2026-11-22T09:00:00Z" } } }, // 後で閉じた→開いていた
  { kind: "confirmation_promised", status: "promised", sent_at: "2026-11-21T06:19:00Z", detail: { closed_by: { sent_at: "2026-11-21T08:00:00Z" } } }, // 前に閉じた
  { kind: "estimate_declared", status: "promised", sent_at: "2026-11-21T06:19:00Z", detail: null },
  { kind: "estimate_sent", status: "done", sent_at: "2026-11-21T07:00:00Z", detail: null }, // 見積の約束は前に済み
  { kind: "pickup_declared", status: "promised", sent_at: "2026-11-22T06:00:00Z", detail: null }, // 判断の後の約束は数えない
  { kind: "confirmation_promised", status: "promised", sent_at: "2026-11-20T00:00:00Z", detail: { closed_by: { kind: "x" } } }, // 時刻の無い閉じは閉じた扱い
];
assert.equal(truthOpenPromises(facts, at), 1);
// 実物の内覧の予定: 時刻のある予定・判断の時刻までに作られた・60日の内
const cal = [
  { start_at: "2026-11-24T05:00:00Z", all_day: false, created_at: "2026-11-21T00:00:00Z" },
  { start_at: "2026-11-24T05:00:00Z", all_day: true, created_at: "2026-11-21T00:00:00Z" }, // 終日＝約束の行
  { start_at: "2026-11-25T05:00:00Z", all_day: false, created_at: "2026-11-22T06:00:00Z" }, // 判断の後に作られた
];
assert.equal(truthTimedViewings(cal, at), 1);
// 木
const turns = situationTurns([
  { id: "a", scene: "question", field: "po", got: 1, truth: 1 },
  { id: "b", scene: "question", field: "po", got: 2, truth: 1 },
  { id: "c", scene: "viewing", field: "tv", got: 0, truth: 1 },
]);
assert.deepEqual(turns.map((t) => `${t.id}:${t.miss}:${t.cause}`), ["a:po:ok:null", "b:po:over:counting", "c:tv:under:material"]);
const nodes = buildSituationTree(turns);
assert.equal(nodes[0].key, SITUATION_MAP_ROOT); assert.deepEqual([nodes[0].n, nodes[0].ok], [3, 1]);
assert.ok(nodes.some((x) => x.key === "situation:match/kind=po/scene=question/miss=over/cause=counting"));
assert.equal(nodes.some((x) => x.parent?.endsWith("miss=ok")), false);
console.log("situation-check: ok");
