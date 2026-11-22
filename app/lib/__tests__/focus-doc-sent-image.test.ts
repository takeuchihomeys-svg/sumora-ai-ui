// npx tsx app/lib/__tests__/focus-doc-sent-image.test.ts
// 2026-11-21 作業員L: 資料の要点に送った資料の読み取りを足す（FOCUS_DOC_SENT_IMAGE・既定 off）
import assert from "node:assert/strict";
import { focusDocSentImageOn, sentFactsDocLines } from "../brain-material-wiring";
import { routeContractTerm } from "../contract-terms-question";

assert.equal(focusDocSentImageOn({}), true); // 2026-11-21 既定 on
assert.equal(focusDocSentImageOn({ FOCUS_DOC_SENT_IMAGE: "off" }), false);

// 送った資料の読み取りの形（sent_image_properties.facts）→ 資料の行の形
assert.deepEqual(sentFactsDocLines({ deposit_months: 0, key_money_months: 1, rent: 65000 }), ["敷金: なし", "礼金: 1ヶ月"]);
assert.deepEqual(sentFactsDocLines({ deposit_yen: 0, key_money_yen: 71000 }), ["敷金: なし", "礼金: 71,000円"]);
// 単位が決まらない欄は作らない（DEPOSIT_UNIT_UNCLEAR の印と同じ線）
assert.deepEqual(sentFactsDocLines({ deposit_months: 2, deposit_unit: "unclear", key_money_months: 1 }), ["礼金: 1ヶ月"]);
assert.deepEqual(sentFactsDocLines(null), []);

// その行で資料の答えの道に乗る（901号室の礼金の穴の形）
const r = routeContractTerm("key_money", { lines: sentFactsDocLines({ key_money_months: 1 }) }, {});
assert.equal(r.route, "material");
assert.deepEqual(r.facts, ["礼金: 1ヶ月"]);

console.log("focus-doc-sent-image: ok");
