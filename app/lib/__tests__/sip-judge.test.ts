// npx tsx app/lib/__tests__/sip-judge.test.ts
// 2026-11-21 作業員K2（台帳 #511）: 売上サポを通らない物件を画像の読みから判定に通す（SIP_JUDGE・既定 off）
import assert from "node:assert/strict";
import { sipJudgeOn, judgeSip, judgeSips } from "../sip-judge";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
// 画像の読みの形（本番の facts の鍵・値は伏せた形）
const facts = { rent: 72000, admin_fee_yen: 8000, room_no: "302", deposit_months: 0, key_money_months: 0, floor_plan: "1LDK", area_sqm: 35.2, station: "本町", walk_minutes: 5, built_ym: "2019年3月" };
const customer = { rent_max: 85000, floor_plan: "1LDK", walk_minutes: 10, building_age: 10, preferences: "初期費用を抑えたい" };
t("既定 off", () => { assert.equal(sipJudgeOn({}), false); assert.equal(sipJudgeOn({ SIP_JUDGE: "on" }), true); });
t("読みから札が付く（家賃・間取り・駅・敷礼0）", () => {
  const j = judgeSip({ property_name: "物件A", room_no: "302", facts }, customer);
  assert.ok(j && j.reason_codes.includes("RENT_OK") && j.reason_codes.includes("FLOOR_PLAN_MATCH"), j?.reason_codes.join(","));
  assert.ok(j!.reason_codes.includes("ZERO_ZERO_MATCH"), j!.reason_codes.join(","));
});
t("お客様・読み・名前が無ければ null", () => {
  assert.equal(judgeSip({ property_name: "物件A", facts }, null), null);
  assert.equal(judgeSip({ property_name: "物件A", facts: null }, customer), null);
  assert.equal(judgeSip({ property_name: "", facts }, customer), null);
});
t("同じ部屋は新しい1つだけ", () => {
  const rows = [{ property_name: "物件A", room_no: "302", facts, created_at: "2026-11-20T00:00:00Z" }, { property_name: "物件A", room_no: "0302", facts, created_at: "2026-11-21T00:00:00Z" }, { property_name: "物件B", room_no: "101", facts, created_at: "2026-11-19T00:00:00Z" }];
  assert.equal(judgeSips(rows, customer).length, 2);
});
console.log(`${n} ok`);
