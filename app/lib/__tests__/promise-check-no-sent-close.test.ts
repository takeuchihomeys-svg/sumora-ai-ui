// npx tsx app/lib/__tests__/promise-check-no-sent-close.test.ts
// 台帳 #856（2026-11-28 作業員L・統括役の決め）: 確認の約束は物件の送付では閉じない（PROMISE_CHECK_NO_SENT_CLOSE=on の時だけ・既定 off は今と同じ）
import assert from "node:assert/strict";
import { promiseFulfilledBy, promiseCheckNoSentCloseOn } from "../promise-drop-watch";
const ON = { PROMISE_CHECK_NO_SENT_CLOSE: "on" }, OFF = {};
const p = { at: "2026-11-22T05:26:00Z", kind: "check" as const, text: "募集状況確認させて頂きます。" };
const sentOnly = { msgs: [], aix: [{ aix_type: "property_send", sent_at: "2026-11-22T06:41:00Z", created_at: "2026-11-22T06:41:00Z" }], sent: [{ sent_at: "2026-11-22T06:00:00Z" }] };
// off: 今と同じ（物件の送付で閉じる）
assert.deepEqual(promiseFulfilledBy(p, sentOnly as never, { env: OFF }), { by: "sent_properties", at: "2026-11-22T06:00:00Z" });
// on: 物件の送付・物件の AIX では閉じない
assert.equal(promiseFulfilledBy(p, sentOnly as never, { env: ON }), null);
// on: 確認の結果の AIX で閉じる（物件の送付より後でも、確認の結果の方を取る）
const withResult = { ...sentOnly, aix: [...sentOnly.aix, { aix_type: "property_check_result", sent_at: "2026-11-22T09:00:00Z", created_at: "2026-11-22T09:00:00Z" }] };
assert.deepEqual(promiseFulfilledBy(p, withResult as never, { env: ON }), { by: "aix:property_check_result", at: "2026-11-22T09:00:00Z" });
// on: 見積の AIX（初期費用の確認の答え）で閉じる
const withEst = { ...sentOnly, aix: [{ aix_type: "estimate_sheet", sent_at: "2026-11-23T01:00:00Z", created_at: "2026-11-23T01:00:00Z" }] };
assert.deepEqual(promiseFulfilledBy(p, withEst as never, { env: ON }), { by: "aix:estimate_sheet", at: "2026-11-23T01:00:00Z" });
// on: こちらの手打ちの確認の結果の文で閉じる
const withText = { ...sentOnly, msgs: [{ sender: "staff", is_aix_generated: false, created_at: "2026-11-22T10:00:00Z", text: "管理会社に確認させて頂きましたところ、募集中とのことでした。" }] };
assert.deepEqual(promiseFulfilledBy(p, withText as never, { env: ON }), { by: "staff_text", at: "2026-11-22T10:00:00Z" });
// on でも他の種類（pickup）は物件の送付で閉じる
assert.deepEqual(promiseFulfilledBy({ ...p, kind: "pickup" }, sentOnly as never, { env: ON }), { by: "sent_properties", at: "2026-11-22T06:00:00Z" });
assert.equal(promiseCheckNoSentCloseOn({}), false); assert.equal(promiseCheckNoSentCloseOn(ON), true);
console.log("promise-check-no-sent-close ok 8");
