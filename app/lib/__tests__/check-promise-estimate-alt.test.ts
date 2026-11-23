// npx tsx app/lib/__tests__/check-promise-estimate-alt.test.ts
// 2026-11-23 作業員K2（台帳 #469）: 確認の約束の番に2つ目として見積書送る（CHECK_PROMISE_ESTIMATE_ALT・既定 off）。言い回しは3番の約束の形（名前・物件は伏せた）
import assert from "node:assert/strict";
import { checkPromiseEstimateAlt, checkPromiseEstimateAltOn } from "../check-promise-estimate-alt";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const base = { promiseKind: "check", promiseAction: "property_check_result", currentAlt: null, propertyInPlay: true };
t("既定 off", () => { assert.equal(checkPromiseEstimateAltOn({}), false); assert.equal(checkPromiseEstimateAltOn({ CHECK_PROMISE_ESTIMATE_ALT: "on" }), true); });
t("お送り頂いたお部屋の募集状況の確認の約束＝見積書を2つ目に（3722 の形）", () => {
  assert.equal(checkPromiseEstimateAlt({ ...base, lastStaffText: "〇〇さん、はじめまして😊！！お送り頂きましたお部屋の募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます😌！！" }), "estimate_sheet");
});
t("募集状況と初期費用の約束（5831 の形）", () => {
  assert.equal(checkPromiseEstimateAlt({ ...base, lastStaffText: "お送り頂きました〇〇の募集状況と、初期費用を最大限抑えられるよう調整した上でご連絡させて頂きます！！" }), null, "「確認」の語が無い形は今の線では拾わない");
  assert.equal(checkPromiseEstimateAlt({ ...base, lastStaffText: "〇〇の募集状況確認させて頂き、初期費用最大限抑えた御見積書お送りさせて頂きます！！" }), "estimate_sheet");
});
t("見積る物件が無い・既に2つ目がある・確認の約束でない時は並べない", () => {
  const txt = "お送り頂きましたお部屋の募集状況確認させて頂きます！！";
  assert.equal(checkPromiseEstimateAlt({ ...base, propertyInPlay: false, lastStaffText: txt }), null);
  assert.equal(checkPromiseEstimateAlt({ ...base, currentAlt: "property_send", lastStaffText: txt }), null);
  assert.equal(checkPromiseEstimateAlt({ ...base, promiseKind: "pickup", promiseAction: "property_send", lastStaffText: txt }), null);
});
t("条件・設備の確認（管理会社に確認）や内覧の可否は並べない", () => {
  assert.equal(checkPromiseEstimateAlt({ ...base, lastStaffText: "ペット可否管理会社に確認させて頂きます！！" }), null);
  assert.equal(checkPromiseEstimateAlt({ ...base, lastStaffText: "〇〇の空き状況とご内覧可能か確認させて頂きます！！" }), null);
});
console.log(`${n} ok`);
