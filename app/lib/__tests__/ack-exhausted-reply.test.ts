// 竹内さんの決定 10/14（約束の直後のお礼・了承＝返信／出し切りの後の条件の足し＝返信で締める）の純関数のテスト
// 実行: npx tsx app/lib/__tests__/ack-exhausted-reply.test.ts
import { exhaustedConditionAddTurn, ackAfterPromiseDirection, ackAfterPromiseReplyEnabled, exhaustedConditionMaterial, ackAfterPromiseMaterial, ackAfterPickupTurn, ackAfterPickupTurnLine, ackAfterPromiseRuleApplies, ackAfterPromiseBrainEnabled, exhaustedConditionBrainEnabled, exhaustedConditionTurnLine, exhaustedConditionAxisEnabled } from "../ack-exhausted-reply";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m} ${x} !== ${y}`); }

it("出し切りの後の条件の足し・言い直し（設備・家賃・間取り・エリア・複数）は返信", () => {
  for (const t of ["equip_add", "rent_change", "layout_change", "area_change", "multi"]) eq(exhaustedConditionAddTurn({ conditionChangeType: t, exhausted: true, ackOnly: false, env: {} }), true, t);
});
it("広げる・物件を送ってほしい・出し切っていない・お礼だけ・止めた時は対象外", () => {
  eq(exhaustedConditionAddTurn({ conditionChangeType: "condition_relax", exhausted: true, ackOnly: false, env: {} }), false);
  eq(exhaustedConditionAddTurn({ conditionChangeType: "pickup_request", exhausted: true, ackOnly: false, env: {} }), false);
  eq(exhaustedConditionAddTurn({ conditionChangeType: "equip_add", exhausted: false, ackOnly: false, env: {} }), false);
  eq(exhaustedConditionAddTurn({ conditionChangeType: "equip_add", exhausted: true, ackOnly: true, env: {} }), false);
  eq(exhaustedConditionAddTurn({ conditionChangeType: "equip_add", exhausted: true, ackOnly: false, env: { EXHAUSTED_CONDITION_REPLY: "off" } }), false);
});
it("約束の直後のお礼の方向は短い返信＋後で AIX", () => {
  const d = ackAfterPromiseDirection("pickup", "property_send");
  eq(/お礼に短く返信/.test(d) && /ピックアップしてお送りする/.test(d) && /【property_send】はその後/.test(d), true, d);
});
it("止めれば材料の文も出ない", () => {
  eq(ackAfterPromiseReplyEnabled({ ACK_AFTER_PROMISE_REPLY: "off" }), false);
  eq(exhaustedConditionMaterial({ EXHAUSTED_CONDITION_REPLY: "off" }), "");
  eq(ackAfterPromiseMaterial({ ACK_AFTER_PROMISE_REPLY: "off" }), "");
  eq(ackAfterPromiseMaterial({}).length > 0, true);
});

// 2026-10-14 決定 C をブレイン基準に
it("決定 C の番（網）: お礼・了承だけ×最後の約束がピックアップ×確認・見積が残っていない", () => {
  const base = { ackOnly: true, nudge: false, lastEntry: { kind: "pickup_declared", status: "promised" }, pickupOpen: true, estimateOpen: false, confirmOpen: false };
  eq(ackAfterPickupTurn(base), true);
  eq(ackAfterPickupTurn({ ...base, ackOnly: false }), false, "中身のある番");
  eq(ackAfterPickupTurn({ ...base, nudge: true }), false, "催促");
  eq(ackAfterPickupTurn({ ...base, lastEntry: { kind: "confirmation_promised", status: "promised" } }), false, "確認の約束（q094）");
  eq(ackAfterPickupTurn({ ...base, confirmOpen: true }), false, "確認の約束が残る");
  eq(ackAfterPickupTurn({ ...base, estimateOpen: true }), false, "見積の約束が残る");
  eq(ackAfterPickupTurn({ ...base, pickupOpen: false }), false, "果たした後");
});
it("規則はブレインが決められなかった時（aix の欄が無い）だけ・ACK_AFTER_PROMISE_BRAIN=off で旧の上書き", () => {
  eq(ackAfterPromiseRuleApplies({ brainMode: true, llmAixPresent: true }), false);
  eq(ackAfterPromiseRuleApplies({ brainMode: true, llmAixPresent: false }), true);
  eq(ackAfterPromiseRuleApplies({ brainMode: false, llmAixPresent: true }), true);
  eq(ackAfterPromiseBrainEnabled({}), true);
  eq(ackAfterPromiseBrainEnabled({ ACK_AFTER_PROMISE_BRAIN: "off" }), false);
  eq(/aix は null/.test(ackAfterPickupTurnLine({})), true);
  eq(ackAfterPickupTurnLine({ ACK_AFTER_PROMISE_BRAIN: "off" }), "");
  eq(ackAfterPickupTurnLine({ ACK_AFTER_PROMISE_REPLY: "off" }), "");
});
it("出し切りの後の条件の足しのブレイン基準（既定 on・off で旧の上書き）", () => {
  eq(exhaustedConditionBrainEnabled({}), true);
  eq(exhaustedConditionBrainEnabled({ EXHAUSTED_CONDITION_BRAIN: "off" }), false);
  eq(/返信で締める/.test(exhaustedConditionTurnLine({})), true);
  eq(exhaustedConditionTurnLine({ EXHAUSTED_CONDITION_REPLY: "off" }), "");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }it("軸（10/15 q153・q154）: ゆるめた・外した番と、探す条件の依頼が無い番（送った物件への反応）は対象外・足した番は今まで通り", () => {
  const b = { conditionChangeType: "rent_change", exhausted: true, ackOnly: false, env: {} };
  eq(exhaustedConditionAddTurn({ ...b, conditionChangeType: "equip_add", axisAsks: [{ about: "search_condition", polarity: "relax" }] }), false, "relax");
  eq(exhaustedConditionAddTurn({ ...b, axisAsks: [{ about: "reaction_to_sent", polarity: null }] }), false, "reaction");
  eq(exhaustedConditionAddTurn({ ...b, conditionChangeType: "equip_add", axisAsks: [{ about: "search_condition", polarity: "add" }] }), true, "add");
  eq(exhaustedConditionAddTurn({ ...b, axisAsks: [] }), true, "軸なし");
  eq(exhaustedConditionAddTurn({ ...b, env: { EXHAUSTED_CONDITION_AXIS: "off" }, axisAsks: [{ about: "reaction_to_sent", polarity: null }] }), true, "off");
  eq(exhaustedConditionAxisEnabled({}), true);
  eq(/ゆるめた/.test(exhaustedConditionTurnLine({})) && /予算オーバー/.test(exhaustedConditionMaterial({})), true);
  eq(/ゆるめた/.test(exhaustedConditionTurnLine({ EXHAUSTED_CONDITION_AXIS: "off" })), false);
});


