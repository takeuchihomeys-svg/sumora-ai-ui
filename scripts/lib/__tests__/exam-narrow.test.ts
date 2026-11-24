// npx tsx scripts/lib/__tests__/exam-narrow.test.ts
// 2026-11-24 作業員L: 積む時の問題の絞り（exam-narrow）
import assert from "node:assert/strict";
import { narrowProblems, baseMajorityOf, examNarrowOn } from "../exam-narrow";

const prior = new Map<string, Record<string, number>>([["q1", { property_pickups: 2 }], ["q2", {}], ["q3", {}]]);
const base = baseMajorityOf([
  { id: "q2", path: { ok: true }, score: { pass: true } }, { id: "q2", path: { ok: true }, score: { pass: true } },
  { id: "q3", path: { ok: false }, score: { pass: false } },
]);
assert.equal(examNarrowOn({}), true);
assert.equal(examNarrowOn({ EXAM_NARROW: "off" }), false);
const r = narrowProblems({ ids: ["q1", "q2", "q3", "q4"], onSwitches: ["PICKUP_WHY_TO_BRAIN"], prior, base });
assert.deepEqual([r.applied, r.keep, r.drop], [true, ["q1", "q3", "q4"], ["q2"]], "材料あり・off で外れ・前の回なしは残す");
const u = narrowProblems({ ids: ["q1", "q2"], onSwitches: ["PICKUP_WHY_TO_BRAIN", "SOME_PROMPT_SWITCH"], prior, base });
assert.equal(u.applied, false, "対応表に無いスイッチがあれば絞らない");
assert.equal(narrowProblems({ ids: ["q2"], onSwitches: ["PICKUP_WHY_TO_BRAIN"], prior, base }).applied, false, "絞ると0問なら絞らない");
console.log("exam-narrow: ok");
