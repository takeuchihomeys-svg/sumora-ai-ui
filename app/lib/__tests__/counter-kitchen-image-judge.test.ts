// npx tsx app/lib/__tests__/counter-kitchen-image-judge.test.ts
// 2026-11-21 作業員K2: カウンターキッチンの画像の読みを判定の設備の照合に受ける（COUNTER_KITCHEN_IMAGE_JUDGE・既定 off）
import assert from "node:assert/strict";
import { counterKitchenImageJudgeOn, counterKitchenImageValue, applyCounterKitchenImage } from "../counter-kitchen-image-judge";
import { buildBatchEquipment } from "../pickup-equipment";
import { applyEquipmentMatch } from "../property-brain";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
// お客様の条件にカウンターキッチン・資料の文字には書いていない
const customer = { preferences: "カウンターキッチン" };
const m = buildBatchEquipment([{ key: 1, pdfText: "設備 バス・トイレ別 エアコン" }], customer).rows[0].match;
t("既定 off・値の読み", () => {
  assert.equal(counterKitchenImageJudgeOn({}), false); assert.equal(counterKitchenImageJudgeOn({ COUNTER_KITCHEN_IMAGE_JUDGE: "on" }), true);
  assert.equal(counterKitchenImageValue({ counter_kitchen: true }), true); assert.equal(counterKitchenImageValue({ counter_kitchen: false }), false);
  assert.equal(counterKitchenImageValue({ counter_kitchen: null }), null); assert.equal(counterKitchenImageValue(null), null);
});
t("資料の文字では記載なし", () => { assert.ok(m.rows.some((r) => r.want.key === "counter_kitchen" && r.result === "unlisted"), JSON.stringify(m.rows.map((r) => [r.want.key, r.result]))); });
const base = applyEquipmentMatch({ reasonCodes: ["RENT_OK"] }, m, null);
t("true は ok（加点）・false は ng（減点）・null は今まで通り", () => {
  const up = applyEquipmentMatch({ reasonCodes: ["RENT_OK"] }, applyCounterKitchenImage(m, true)!, null);
  const dn = applyEquipmentMatch({ reasonCodes: ["RENT_OK"] }, applyCounterKitchenImage(m, false)!, null);
  assert.ok(up.reasonCodes.some((c) => /^EQUIP_COUNTER_KITCHEN_.*OK$/.test(c)) && up.score > base.score, `${up.reasonCodes} ${up.score} ${base.score}`);
  assert.ok(dn.reasonCodes.some((c) => /^EQUIP_COUNTER_KITCHEN_.*NG$/.test(c)) && dn.score < base.score, `${dn.reasonCodes} ${dn.score} ${base.score}`);
  assert.equal(applyCounterKitchenImage(m, null), null);
});
t("資料の文字で決まっている行は変えない", () => {
  const m2 = { ...m, rows: m.rows.map((r) => (r.want.key === "counter_kitchen" ? { ...r, result: "ok" as const } : r)) };
  assert.equal(applyCounterKitchenImage(m2, false), null);
});
console.log(`${n} ok`);
