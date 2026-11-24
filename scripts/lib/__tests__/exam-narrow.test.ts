// npx tsx scripts/lib/__tests__/exam-narrow.test.ts
// 2026-11-24 作業員L: 積む時の問題の絞り（exam-narrow）
import assert from "node:assert/strict";
import { narrowProblems, baseMajorityOf, examNarrowOn, examNarrowSteadyOn, SWITCH_SCENE } from "../exam-narrow";
import { SWITCH_REACH } from "../exam-switch-reach";

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
// 2026-11-24 作業員L: 場面の表（返信の下書きのスイッチ）・BRAIN_FOCUS_DOC_DIGEST の材料
{
  const np = narrowProblems, bm = baseMajorityOf;
  assert.deepEqual(SWITCH_REACH.BRAIN_FOCUS_DOC_DIGEST?.needs, ["property_pickups", "sent_image_properties"]);
  assert.equal(SWITCH_SCENE.COMPOSE_CLOSING_TABLE.where, "reply_draft");
  assert.deepEqual(SWITCH_REACH.PROPERTY_THREAD_PHOTO_SENT?.needs, ["aix_usage_logs"]);
  const b2 = bm([
    { id: "a", path: { ok: true }, score: { pass: true }, draft: { text: "返信の文" } },
    { id: "b", path: { ok: true }, score: { pass: true }, draft: { text: null } },
    { id: "b", path: { ok: true }, score: { pass: true }, draft: { text: null } },
    { id: "c", path: { ok: false }, score: { pass: false }, draft: { text: null } },
  ] as never);
  const r2 = np({ ids: ["a", "b", "c", "d"], onSwitches: ["COMPOSE_CLOSING_TABLE"], prior: new Map(), base: b2 });
  assert.deepEqual([r2.applied, r2.keep, r2.drop], [true, ["a", "c", "d"], ["b"]], "下書きが出る・off で外れ・前の答えなしは残す");
  assert.equal(np({ ids: ["a", "b"], onSwitches: ["COMPOSE_CLOSING_TABLE"], prior: new Map(), base: b2, scene: null }).applied, false, "場面の表を止めると絞らない");
  assert.equal(np({ ids: ["a", "b"], onSwitches: ["COMPOSE_CLOSING_TABLE", "TSUNAGI_ONE_PLACE"], prior: new Map(), base: b2 }).applied, false, "場面が決まらないスイッチと一緒なら絞らない");
  // 揺れていない（off で2回以上・全部当たり）だけ落とす
  const b3 = bm([
    { id: "s", path: { ok: true }, score: { pass: true } }, { id: "s", path: { ok: true }, score: { pass: true } },
    { id: "w", path: { ok: true }, score: { pass: true } }, { id: "w", path: { ok: true }, score: { pass: true } }, { id: "w", path: { ok: false }, score: { pass: false } },
    { id: "o", path: { ok: true }, score: { pass: true } },
  ]);
  const pr3 = new Map<string, Record<string, number>>([["s", {}], ["w", {}], ["o", {}], ["m", { property_pickups: 1 }]]);
  const r3 = np({ ids: ["s", "w", "o", "m"], onSwitches: ["PICKUP_WHY_TO_BRAIN"], prior: pr3, base: b3 });
  assert.deepEqual([r3.keep, r3.drop], [["w", "o", "m"], ["s"]], "揺れている・1回だけの off は残す");
  assert.equal(examNarrowSteadyOn({}), true);
  process.env.EXAM_NARROW_STEADY = "off";
  assert.deepEqual(np({ ids: ["s", "w", "o", "m"], onSwitches: ["PICKUP_WHY_TO_BRAIN"], prior: pr3, base: b3 }).drop, ["s", "w", "o"], "=off で過半数に戻る");
  delete process.env.EXAM_NARROW_STEADY;
  console.log("exam-narrow scene: ok");
}
