// npx tsx app/lib/__tests__/unspoken-good-points.test.ts
// 2026-11-21 作業員K2（台帳 #479）: お客様が言っていない良い点（UNSPOKEN_GOOD_POINTS・既定 off）
import assert from "node:assert/strict";
import { unspokenGoodPoints, unspokenGoodPointsOn } from "../unspoken-good-points";
import { pickupWhyOf } from "../pickup-why-line";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
t("既定 off", () => { assert.equal(unspokenGoodPointsOn({}), false); assert.equal(unspokenGoodPointsOn({ UNSPOKEN_GOOD_POINTS: "on" }), true); });
t("敷礼0（言っていない人）・リノベ済み", () => {
  assert.deepEqual(unspokenGoodPoints({ terms: { deposit: 0, keyMoney: 0, renovated: true }, reason_codes: ["RENT_OK"] }), ["GOOD_ZERO_ZERO", "GOOD_RENOVATED"]);
});
t("初期費用を言った人（ZERO_ZERO_MATCH がある）・敷金ありは足さない", () => {
  assert.deepEqual(unspokenGoodPoints({ terms: { deposit: 0, keyMoney: 0 }, reason_codes: ["ZERO_ZERO_MATCH"] }), []);
  assert.deepEqual(unspokenGoodPoints({ terms: { deposit: 1, keyMoney: 0 }, reason_codes: [] }), []);
  assert.deepEqual(unspokenGoodPoints({ terms: null, reason_codes: [] }), []);
});
t("選んだ理由の1行に出るのは on の時だけ", () => {
  const row = { property_name: "物件A", room_no: "301", recommended: 1, score: 150, reason_codes: ["RENT_OK", "FLOOR_PLAN_MATCH"], sent_at: "2026-11-20T03:00:00Z", terms: { deposit: 0, keyMoney: 0 } };
  const now = Date.parse("2026-11-21T03:00:00Z");
  const prev = process.env.UNSPOKEN_GOOD_POINTS;
  delete process.env.UNSPOKEN_GOOD_POINTS;
  assert.ok(!pickupWhyOf([row], { nowMs: now })[0].good.some((g) => /言っていない/.test(g)));
  process.env.UNSPOKEN_GOOD_POINTS = "on";
  assert.ok(pickupWhyOf([row], { nowMs: now })[0].good.some((g) => /敷金・礼金0/.test(g)));
  if (prev === undefined) delete process.env.UNSPOKEN_GOOD_POINTS; else process.env.UNSPOKEN_GOOD_POINTS = prev;
});
console.log(`${n} ok`);
