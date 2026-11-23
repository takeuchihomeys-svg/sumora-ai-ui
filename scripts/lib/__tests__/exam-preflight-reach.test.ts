// npx tsx scripts/lib/__tests__/exam-preflight-reach.test.ts
// 2026-11-23 作業員N2（台帳 #462）: 積む前の届きの点検・費用の無駄
import assert from "node:assert/strict";
import { preflightReachOf, preflightLines, wastedCostOf } from "../exam-preflight-reach";
const prior = new Map<string, Record<string, number>>([["q1", { sent_facts: 1 }], ["q2", { sent_image_properties: 3 }], ["q3", {}]]);
const r = preflightReachOf(["SIP_JUDGE", "BRAIN_RULE6_OPEN_PROMISE", "NOT_IN_TABLE"], ["q1", "q2", "q3", "q9"], prior);
assert.equal(r.length, 1, "写しの材料が要らない・対応表に無いスイッチは積む前には見ない");
assert.deepEqual([r[0].noMaterial, r[0].withMaterial, r[0].unknown, r[0].warn], [["q1", "q3"], ["q2"], ["q9"], false]);
const all0 = preflightReachOf(["SIP_JUDGE"], ["q1", "q3"], prior);
assert.equal(all0[0].warn, true, "効く問題が1つも無い");
assert.match(preflightLines(all0)[0], /効く問題が1つも無い/);
assert.match(preflightLines([], { repeat: 1 })[0], /1回ずつの比べ/);
assert.equal(preflightLines([], { repeat: 3 }).length, 0);
const w = wastedCostOf([
  { label: "a", cost: 1, reach: [{ status: "no_material" }] },
  { label: "b", cost: 0.5, reach: [{ status: "no_material" }, { status: "mark_after_head" }] },
  { label: "c", cost: 2, reach: [{ status: "unknown" }] },
  { label: "d", cost: 3, reach: [{ status: "reached" }] },
]);
assert.deepEqual([w.wasted, w.partial, w.unverified, w.total], [1, 0.5, 2, 6.5]);
console.log("exam-preflight-reach: ok");
