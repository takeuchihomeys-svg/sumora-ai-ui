// npx tsx app/lib/__tests__/promise-call-view-fulfil.test.ts
// 台帳 #669（2026-11-28 作業員L）: 電話・内覧の調整の約束の果たした印（PROMISE_CALL_VIEW_FULFIL=on の時だけ・既定 off は今と同じ n/a）
import assert from "node:assert/strict";
import { promiseFulfilledBy, promiseCallViewFulfilOn } from "../promise-drop-watch";
const ON = { PROMISE_CALL_VIEW_FULFIL: "on" }, OFF = {};
const at = "2026-11-17T04:10:00Z";
const cb = { at, kind: "callback" as const, text: "折り返しお電話させて頂きます。" };
const vs = { at, kind: "viewing_slot" as const, text: "ご内覧の日程を確認させて頂きます。" };
const empty = { msgs: [], aix: [], sent: [] };
// off: 今と同じ（判定なし）
assert.equal(promiseFulfilledBy(cb, empty, { env: OFF }), "n/a");
assert.equal(promiseFulfilledBy(vs, empty, { env: OFF }), "n/a");
// 電話: AIX phone_call で果たした（c40e1625 の形・23時間後）
assert.deepEqual(promiseFulfilledBy(cb, { ...empty, aix: [{ aix_type: "phone_call", sent_at: null, created_at: "2026-11-18T03:00:00Z" }] }, { env: ON }), { by: "aix:phone_call", at: "2026-11-18T03:00:00Z" });
// 電話: お客様の「お電話ありがとうございました」でも果たした
assert.deepEqual(promiseFulfilledBy(cb, { ...empty, msgs: [{ sender: "customer", text: "先ほどはお電話ありがとうございました！", created_at: "2026-11-17T06:00:00Z" }] }, { env: ON }), { by: "customer_text", at: "2026-11-17T06:00:00Z" });
// 電話: 印が無い＝LINE の外で済んだかもしれない＝判定しない（110b3053 の形・期日超えにしない）
assert.equal(promiseFulfilledBy(cb, { ...empty, msgs: [{ sender: "staff", is_aix_generated: false, text: "かしこまりました。", created_at: "2026-11-17T05:00:00Z" }] }, { env: ON }), "n/a");
// 電話: 約束より前の印は数えない
assert.equal(promiseFulfilledBy(cb, { ...empty, aix: [{ aix_type: "phone_call", sent_at: null, created_at: "2026-11-16T00:00:00Z" }] }, { env: ON }), "n/a");
// 内覧の調整: こちらの手打ちの文に内覧と日時で果たした（7f73dc32 の形・19時間後）
assert.deepEqual(promiseFulfilledBy(vs, { ...empty, msgs: [{ sender: "staff", is_aix_generated: false, text: "ご内覧ですが12月1日 14時から可能です！", created_at: "2026-11-17T23:00:00Z" }] }, { env: ON }), { by: "staff_text", at: "2026-11-17T23:00:00Z" });
// 内覧の調整: 内覧の AIX で果たした
assert.deepEqual(promiseFulfilledBy(vs, { ...empty, aix: [{ aix_type: "viewing_invite", sent_at: "2026-11-18T01:00:00Z", created_at: "2026-11-18T01:00:00Z" }] }, { env: ON }), { by: "aix:viewing_invite", at: "2026-11-18T01:00:00Z" });
// 内覧の調整: 言い直しの約束（それ自体が調整の約束の文）は果たした印にしない
assert.equal(promiseFulfilledBy(vs, { ...empty, msgs: [{ sender: "staff", is_aix_generated: false, text: "ご内覧の日程を確認させて頂きます。12月1日になるかと存じます。", created_at: "2026-11-17T23:00:00Z" }] }, { env: ON }), null);
// 内覧の調整: 印が無ければ果たしていない（LINE の中で済む物）
assert.equal(promiseFulfilledBy(vs, empty, { env: ON }), null);
// 日時の無い内覧の言葉だけは印にしない
assert.equal(promiseFulfilledBy(vs, { ...empty, msgs: [{ sender: "staff", is_aix_generated: false, text: "ご内覧お待ちしております。", created_at: "2026-11-17T23:00:00Z" }] }, { env: ON }), null);
assert.equal(promiseCallViewFulfilOn({}), false); assert.equal(promiseCallViewFulfilOn(ON), true);
console.log("promise-call-view-fulfil ok 13");
