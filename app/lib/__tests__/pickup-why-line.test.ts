// npx tsx app/lib/__tests__/pickup-why-line.test.ts
// 2026-11-21 作業員K2: 送った物件を選んだ理由をブレインの材料に（PICKUP_WHY_TO_BRAIN・既定 off）
import assert from "node:assert/strict";
import { pickupWhyOf, pickupWhyLine, pickupWhyToBrainOn } from "../pickup-why-line";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const now = Date.parse("2026-11-21T03:00:00Z");
// 本番の札（11/21 の送った行の写し・名前は伏せた）
const crown = { property_name: "物件A", room_no: "301", recommended: 1, score: 198, sent_at: "2026-11-20T03:00:00Z",
  reason_codes: ["RENT_OK", "RENT_BAND_UPPER", "ZERO_ZERO_MATCH", "FLOOR_PLAN_MATCH", "SQM_SLIGHTLY_UNDER", "WALK_OK", "BUILDING_AGE_WIDE", "AD_HIGH", "AD_2_5M", "MOVE_IN_OK", "EQUIP_PET_OK", "AREA_STATION_MATCH", "SEARCH_PINPOINT", "CLOSING_FIT", "FIT_ALL"] };
const held = { property_name: "物件B", room_no: "102", recommended: 0, score: 117, sent_at: "2026-11-20T03:00:00Z",
  reason_codes: ["RENT_OK", "ZERO_ZERO_MATCH", "FLOOR_PLAN_MATCH", "SQM_OK", "BUILDING_AGE_OVER", "AD_HIGH_HELD", "SEARCH_PINPOINT_HELD"] };

t("既定 off", () => { assert.equal(pickupWhyToBrainOn({}), false); assert.equal(pickupWhyToBrainOn({ PICKUP_WHY_TO_BRAIN: "on" }), true); });
t("👑が先・社内の札（AD・検索・決め手・帯）は入れない", () => {
  const w = pickupWhyOf([held, crown], { nowMs: now });
  assert.equal(w[0].name, "物件A 301"); assert.equal(w[0].crown, true);
  const all = w.flatMap((x) => [...x.good, ...x.bad]).join("|");
  assert.ok(!/AD|ピンポイント|決め手|上限寄り/.test(all), all);
  assert.ok(w[0].good.length > 0 && w[0].good.length <= 3);
  assert.ok(w[1].bad.some((b) => /築年/.test(b)), JSON.stringify(w[1]));
});
t("72時間より前・送っていない行は出さない", () => {
  assert.equal(pickupWhyOf([{ ...crown, sent_at: "2026-11-15T00:00:00Z" }], { nowMs: now }).length, 0);
  assert.equal(pickupWhyOf([{ ...crown, sent_at: null }], { nowMs: now }).length, 0);
});
t("1行の形", () => {
  const line = pickupWhyLine(pickupWhyOf([crown, held], { nowMs: now }));
  assert.ok(line.startsWith("【送った物件を選んだ理由"));
  assert.ok(line.includes("🌟物件A 301: 合う点"));
  assert.equal(pickupWhyLine([]), "");
  console.log(line);
});
console.log(`${n} ok`);
