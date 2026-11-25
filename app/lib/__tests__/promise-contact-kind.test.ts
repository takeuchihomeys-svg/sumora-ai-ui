// 台帳 #726（作業員L 11/25）: 連絡・交渉の約束の種類と果たした印（PROMISE_CONTACT_KIND・既定 off）
import assert from "node:assert/strict";
import { promiseKindNameOf, promiseFulfilledBy, promiseContactKindOf, promiseContactKindOn } from "../promise-drop-watch";

const ON = { PROMISE_CONTACT_KIND: "on" };
const at = (h: number) => new Date(Date.parse("2026-11-20T03:00:00Z") + h * 3_600_000).toISOString();

// 既定 off: 今と同じ（other・判定なし）
assert.equal(promiseContactKindOn({}), false);
assert.equal(promiseKindNameOf("大家さんにご連絡させて頂きます！！", {}), "other");
assert.equal(promiseKindNameOf("大家さんにお伝えさせて頂きます！！", {}), null);
assert.equal(promiseFulfilledBy({ at: at(0), kind: "contact" }, { msgs: [], aix: [], sent: [] }), "n/a");
// 種類
assert.equal(promiseContactKindOf("礼金の件、交渉させて頂きます！！"), "negotiate");
assert.equal(promiseContactKindOf("大家さんにお伝えさせて頂きます！！"), "contact");
assert.equal(promiseContactKindOf("ご査収ください"), null);
assert.equal(promiseKindNameOf("大家さんにお伝えさせて頂きます！！", ON), "contact");
// ほかの網が先（確認の約束は check のまま）
assert.equal(promiseKindNameOf("募集状況確認させて頂きます！！", ON), "check");
// 果たした印
const staff = (h: number, text: string, aix = false) => ({ sender: "staff", text, created_at: at(h), is_aix_generated: aix });
assert.deepEqual(promiseFulfilledBy({ at: at(0), kind: "contact" }, { msgs: [staff(5, "管理会社に確認したところ、ペット可との事でした！！")], aix: [], sent: [] }, { env: ON }), { by: "staff_text", at: at(5) });
assert.equal(promiseFulfilledBy({ at: at(0), kind: "contact" }, { msgs: [staff(5, "改めてご連絡させて頂きます！！")], aix: [], sent: [] }, { env: ON }), null);
assert.deepEqual(promiseFulfilledBy({ at: at(0), kind: "negotiate" }, { msgs: [staff(3, "交渉の結果、礼金無料にして頂けました！！")], aix: [], sent: [] }, { env: ON }), { by: "staff_text", at: at(3) });
assert.deepEqual(promiseFulfilledBy({ at: at(0), kind: "negotiate" }, { msgs: [], aix: [{ aix_type: "estimate_sheet", sent_at: at(8), created_at: at(8) }], sent: [] }, { env: ON }), { by: "aix:estimate_sheet", at: at(8) });
assert.equal(promiseFulfilledBy({ at: at(0), kind: "negotiate" }, { msgs: [staff(-1, "交渉の結果…")], aix: [], sent: [] }, { env: ON }), null);
console.log("promise-contact-kind ok 14");
