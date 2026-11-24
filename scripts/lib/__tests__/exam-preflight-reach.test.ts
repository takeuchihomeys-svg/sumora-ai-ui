// npx tsx scripts/lib/__tests__/exam-preflight-reach.test.ts
// 2026-11-23 作業員N2（台帳 #462）: 積む前の届きの点検・費用の無駄
import assert from "node:assert/strict";
import { preflightReachOf, preflightLines, wastedCostOf, preflightGate, preflightGateMode } from "../exam-preflight-reach";
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
// 2026-11-24 作業員L: 積む前の関所（既定＝関所・warn＝警告だけ・off）
assert.equal(preflightGateMode({}), "gate");
assert.equal(preflightGateMode({ EXAM_PREFLIGHT_REACH: "warn" }), "warn");
assert.equal(preflightGateMode({ EXAM_PREFLIGHT_REACH: "off" }), "off");
const g1 = preflightGate(all0, ["q1", "q3"]);
assert.deepEqual([g1.block, g1.keep], [["SIP_JUDGE"], []], "全部の問題で材料0＝積まない");
const g2 = preflightGate(preflightReachOf(["SIP_JUDGE"], ["q1", "q2", "q3"], prior), ["q1", "q2", "q3"]);
assert.deepEqual([g2.block, g2.drop, g2.keep], [[], ["q1", "q3"], ["q2"]], "一部だけ0＝その問題を外す");
const g3 = preflightGate(r, ["q1", "q2", "q3", "q9"]);
assert.deepEqual([g3.block, g3.drop, g3.keep], [[], ["q1", "q3"], ["q2", "q9"]], "前の回が無い問題（q9）は外さない");
const g4 = preflightGate(preflightReachOf(["SIP_JUDGE"], ["q1", "q9"], prior), ["q1", "q9"]);
assert.deepEqual(g4.block, [], "前の回が無い問題があれば積むのを止めない");
assert.deepEqual(preflightGate(all0, ["q1", "q3"], "warn").block, [], "warn は今まで通り止めない");
assert.deepEqual(preflightGate([], ["q1"]).keep, ["q1"], "材料の要るスイッチが無ければ何もしない");
console.log("exam-preflight-reach: ok");
