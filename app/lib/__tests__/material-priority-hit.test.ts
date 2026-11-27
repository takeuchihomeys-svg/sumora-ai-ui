// 2026-11-26 作業員L（竹内さん「統括の連携と優先度・かなり重要」）: MATERIAL_PRIORITY の shadow の当たり
// 実行: npx tsx app/lib/__tests__/material-priority-hit.test.ts
import assert from "node:assert/strict";
import { priorityHitsOf } from "../material-priority";
import { nightZeroCostSteps } from "../../../scripts/lib/exam-night-jobs";

const mpr = (keys: string) => `mp-v2|s|r|${keys}|`;
const r = priorityHitsOf([
  { conv: "c1", at: "t1", digest: { mpr: mpr("check_promise_flow,now_fulfillable"), cpf: "a" }, takeuchiAix: "property_check_result" },
  { conv: "c2", at: "t2", digest: { mpr: mpr("check_promise_flow"), cpf: "a" }, takeuchiAix: "" },
  { conv: "c3", at: "t3", digest: { mpr: mpr("station_state") }, takeuchiAix: "estimate_sheet" },
  { conv: "c4", at: "t4", digest: { mpr: mpr("check_promise_flow"), cpf: "a" }, takeuchiAix: null },
  { conv: "c5", at: "t5", digest: { mpr: mpr("") }, takeuchiAix: "" },
  { conv: "c6", at: "t6", digest: {}, takeuchiAix: "" },
]);
assert.deepEqual([r.turns, r.hit, r.miss, r.undecided, r.rate], [3, 1, 1, 1, 50], "竹内さんの番だけ・キーのある番だけ");
assert.deepEqual(r.hits, [{ conv: "c1", at: "t1", keys: ["check_promise_flow", "now_fulfillable"] }], "当たった番と当たったキー");
assert.deepEqual(r.byKey.check_promise_flow, { hit: 1, of: 2 });
assert.ok(nightZeroCostSteps("x.json").some((s) => s.args[0] === "scripts/audit-material-priority-hit.ts" && s.args.includes("--write")), "晩の費用0の仕事");
console.log("material-priority-hit ok 4");
