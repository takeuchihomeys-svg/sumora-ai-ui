// npx tsx scripts/lib/__tests__/hole-reach-weekly.test.ts
// 2026-11-23 作業員N2（KB 0f38f47f）: 地図の穴が統括に届いているかの週1回の一覧
import assert from "node:assert/strict";
import { isHoleReachDay, reachOfRow, holesNotReached } from "../hole-reach-weekly";
import { ownerOfLeaf, leafReachOf } from "../../../app/lib/metric-map";

// 2026-11-23 は月曜（JST）・11-24 は火曜
assert.equal(isHoleReachDay(Date.parse("2026-11-23T03:00:00Z"), {}), true);
assert.equal(isHoleReachDay(Date.parse("2026-11-24T03:00:00Z"), {}), false);
assert.equal(isHoleReachDay(Date.parse("2026-11-24T03:00:00Z"), { HOLE_REACH_WEEKDAY: "2" }), true);
// 列 → 次の一手の頭の印 → 未確認
assert.equal(reachOfRow({ id: 1, title: "地図の穴: x", owner: null, stage: "todo", conductor_reach: "届いている" }), "届いている");
assert.equal(reachOfRow({ id: 1, title: "地図の穴: x", owner: null, stage: "todo", next_step: "［統括に届いているか: 届いていない］外れ 3/5" }), "届いていない");
assert.equal(reachOfRow({ id: 1, title: "地図の穴: x", owner: null, stage: "todo" }), "未確認");
const rows = [
  { id: 3, title: "地図の穴: a", owner: "作業員P", stage: "todo", conductor_reach: "未確認" },
  { id: 2, title: "地図の穴: b", owner: "作業員A", stage: "todo", conductor_reach: "届いている" },
  { id: 1, title: "地図の穴: c", owner: "作業員A", stage: "done", conductor_reach: "未確認" },
  { id: 4, title: "読む窓が狭い: d", owner: "作業員A", stage: "todo", conductor_reach: null },
  { id: 5, title: "地図の穴: e", owner: "作業員A", stage: "building", conductor_reach: "届いていない" },
];
assert.deepEqual(holesNotReached(rows).map((r) => r.id), [5, 3], "開いている地図の穴で届いていない物だけ・持ち主の順");
// 作業員P の持ち主の案と届いているかの決め（使う形の確かめ）
assert.equal(ownerOfLeaf("aix_turn:match_60d_device/kind=zenryoku_support/scene=question", "作業員A").owner, "作業員N2");
assert.equal(ownerOfLeaf("aix_turn:match_60d_device/kind=greeting_viewing/scene=ack", "作業員A").why, "根の持ち主");
assert.equal(leafReachOf("aix_turn:match_60d_device/kind=property/scene=ack", []), "未確認");
assert.equal(leafReachOf("aix_turn:match_60d_device/kind=property/scene=ack", ["aix_turn:match_60d_device/kind=property"]), "届いている");
assert.equal(leafReachOf("aix_turn:match_60d_device/kind=property/scene=ack", ["aix_turn:match_60d_device/kind=estimate_sheet"]), "届いていない");
console.log("hole-reach-weekly: ok");

// 2026-11-23 案b: 弱い駅の穴と1回の上限
import { weakStationHolesOf, holesMaxNew } from "../hole-reach-weekly";
{
  const R = "route:progress_60d";
  const nodes = [
    { key: R, parent: null, depth: 0, dim: null, val: null, n: 60, ok: 20, misses: 40, value: 33 },
    { key: `${R}/station=proposing`, parent: R, depth: 1, dim: "station", val: "proposing", n: 20, ok: 5, misses: 15, value: 25 },
    { key: `${R}/station=proposing/miss=stuck`, parent: `${R}/station=proposing`, depth: 2, dim: "miss", val: "stuck", n: 7, ok: 0, misses: 7, value: 0 },
    { key: `${R}/station=proposing/miss=left`, parent: `${R}/station=proposing`, depth: 2, dim: "miss", val: "left", n: 5, ok: 0, misses: 5, value: 0 },
    { key: `${R}/station=hearing`, parent: R, depth: 1, dim: "station", val: "hearing", n: 12, ok: 6, misses: 6, value: 50 },
    { key: `${R}/station=hearing/miss=stuck`, parent: `${R}/station=hearing`, depth: 2, dim: "miss", val: "stuck", n: 3, ok: 0, misses: 3, value: 0 },
    { key: `${R}/station=pickup`, parent: R, depth: 1, dim: "station", val: "pickup", n: 8, ok: 0, misses: 8, value: 0 },
  ];
  const w = weakStationHolesOf(nodes, new Map([["hearing", { n: 11, value: 60 }]]));
  assert.deepEqual(w.map((x) => x.station), ["proposing", "hearing"], "止まり＋離れが過半数の駅・前の週より下がった駅・n10 未満は外す");
  assert.match(w[0].reasons[0], /止まり＋離れが過半数（12\/20）/);
  assert.match(w[1].reasons[0], /前の週より下がった（60%→50%）/);
  assert.equal(holesMaxNew(Date.parse("2026-11-23T21:30:00Z"), {}), 5, "初めての夜（11/24 06:30 JST の回）は5行");
  assert.equal(holesMaxNew(Date.parse("2026-11-25T21:30:00Z"), {}), 0, "翌晩から上限なし");
  assert.equal(holesMaxNew(Date.parse("2026-11-25T21:30:00Z"), { MAP_HOLES_MAX_NEW: "3" }), 3);
  console.log("weak-station-holes: ok");
}