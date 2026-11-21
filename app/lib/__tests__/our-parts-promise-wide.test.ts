// npx tsx app/lib/__tests__/our-parts-promise-wide.test.ts
// 2026-11-21 作業員L（台帳 #56）: OUR_PARTS_PROMISE_WIDE（既定 off）。本番の meta.situation_now.our_items で約束に数えていなかった文（そのまま）
import assert from "node:assert/strict";
import { splitOurPartsFine, ourPartsPromiseWideOn } from "../our-part-types";

const at = "2026-11-21T03:16:26.355Z";
const NEGOTIATE = "管理会社担当者さんから退去立会後にご内覧いただけるよう交渉させていただきます！";
const CALL = "昨日、今日とお休みの可能性もございますので再度明日お電話かけさせていただきます！";
const GREET = "オカくんさん、はじめまして😊！";
const ON = { OUR_PARTS_PROMISE_WIDE: "on" };

assert.equal(ourPartsPromiseWideOn({}), false);
// off: 今と同じ
assert.equal(splitOurPartsFine(NEGOTIATE, at, {})[0].key, "invite.viewing_door");
assert.equal(splitOurPartsFine(CALL, at, {})[0].key, "fact.answer");
assert.equal(splitOurPartsFine(GREET, at, {})[0]?.key, "fact.answer");
// on: 約束に
const n = splitOurPartsFine(NEGOTIATE, at, ON)[0];
assert.equal(n.key, "promise.negotiate"); assert.equal(n.kind, "promise"); assert.equal(n.expect, "fulfil");
assert.equal(splitOurPartsFine(CALL, at, ON)[0].key, "promise.call");
assert.equal(splitOurPartsFine(GREET, at, ON).length, 0);
// on でも、今の約束の網に当たる文はそのまま
assert.equal(splitOurPartsFine("空室状況を確認させて頂きます！", at, ON)[0].key, "promise.check");
assert.equal(splitOurPartsFine("豊中・蛍池周辺全域からオススメできるお部屋新たにピックアップしてお送りさせて頂きます😊！", at, ON)[0].key, splitOurPartsFine("豊中・蛍池周辺全域からオススメできるお部屋新たにピックアップしてお送りさせて頂きます😊！", at, {})[0].key);
// 電話の言葉が無い内覧の扉は on でも変わらない
assert.equal(splitOurPartsFine("ご内覧も可能でございます！", at, ON)[0]?.key, splitOurPartsFine("ご内覧も可能でございます！", at, {})[0]?.key);
console.log("our-parts-promise-wide: ok");
