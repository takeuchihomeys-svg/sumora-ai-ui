// npx tsx app/lib/__tests__/pickup-rejudge-equipment.test.ts
// 2026-11-21 作業員K2: 条件が変わった後の送る前の候補の付け直し（PICKUP_REJUDGE_ON_COND・既定 off）
import assert from "node:assert/strict";
import { pickupRejudgeOn, needsEquipRejudge, savedWantKeys } from "../pickup-rejudge-equipment";
import { parseEquipmentWants } from "../listing-equipment";
import { buildBatchEquipment } from "../pickup-equipment";
import { applyEquipmentMatch } from "../property-brain";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
t("既定 off", () => { assert.equal(pickupRejudgeOn({}), false); assert.equal(pickupRejudgeOn({ PICKUP_REJUDGE_ON_COND: "on" }), true); });
const before = { preferences: "バス・トイレ別" };
const after = { preferences: "バス・トイレ別・室内洗濯機置き場・独立洗面台" };
const pdf = "設備 バス・トイレ別 室内洗濯機置場 独立洗面台 エアコン";
t("希望の組が同じなら付け直さない・増えたら付け直す", () => {
  const saved = buildBatchEquipment([{ key: 1, pdfText: pdf }], before).rows[0].saved;
  assert.ok(savedWantKeys(saved).size >= 1);
  assert.equal(needsEquipRejudge(saved, parseEquipmentWants(before).wants), false);
  assert.equal(needsEquipRejudge(saved, parseEquipmentWants(after).wants), true);
  assert.equal(needsEquipRejudge(null, parseEquipmentWants(after).wants), true);
  assert.equal(needsEquipRejudge(null, []), false);
});
t("付け直すと新しい希望の札が付く（applyEquipmentMatch・既存の札は残す）", () => {
  const m = buildBatchEquipment([{ key: 1, pdfText: pdf }], after).rows[0].match;
  const j = applyEquipmentMatch({ reasonCodes: ["RENT_OK", "FLOOR_PLAN_MATCH"] }, m, null);
  assert.ok(j.reasonCodes.includes("RENT_OK") && j.reasonCodes.includes("FLOOR_PLAN_MATCH"));
  assert.ok(j.reasonCodes.some((c) => /^EQUIP_WASHBASIN_/.test(c)), j.reasonCodes.join(","));
  assert.ok(j.reasonCodes.some((c) => /^EQUIP_LAUNDRY_IN_/.test(c)), j.reasonCodes.join(","));
});
console.log(`${n} ok`);
