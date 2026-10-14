// 竹内さんの決定 10/14（約束の直後のお礼・了承＝返信／出し切りの後の条件の足し＝返信で締める）の純関数のテスト
// 実行: npx tsx app/lib/__tests__/ack-exhausted-reply.test.ts
import { exhaustedConditionAddTurn, ackAfterPromiseDirection, ackAfterPromiseReplyEnabled, exhaustedConditionMaterial, ackAfterPromiseMaterial } from "../ack-exhausted-reply";

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
