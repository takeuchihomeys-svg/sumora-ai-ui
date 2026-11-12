// npx tsx app/lib/__tests__/compose-head.test.ts
import assert from "node:assert/strict";
import { headWordOf, headNote, composeHeadSplitOn, customerKindOf, prevKindOf } from "../compose-head";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const sent = { text: "🌟ベラジオ 302\n（オススメポイント）", aix: true };
const promised = { text: "募集状況確認させて頂きます！！", aix: false };

t("お客様の文の種類と直前のこちらの送信で分ける", () => {
  assert.equal(customerKindOf("ありがとうございます！"), "thanks");
  assert.equal(customerKindOf("ペット可ですか？"), "question");
  assert.equal(customerKindOf("[画像]"), "sent");
  assert.equal(prevKindOf(null), "first");
  assert.equal(prevKindOf(sent), "sent");
  assert.equal(headWordOf({ customerText: "ありがとうございます！", prev: sent }).word, "hai");
  assert.equal(headWordOf({ customerText: "ペット可ですか？", prev: sent }).word, "none");
  assert.equal(headWordOf({ customerText: "ペット可ですか？", prev: promised }).word, "kashikomari");
  assert.equal(headWordOf({ customerText: "梅田あたりで探してほしいです", prev: null }).word, "none");
  assert.equal(headWordOf({ customerText: "もう少し安いところでお願いします", prev: sent }).word, "kashikomari");
});
t("既定 off は何も足さない", () => {
  assert.equal(composeHeadSplitOn({}), false);
  assert.equal(headNote({ customerText: "ありがとうございます", prev: sent }, {}), "");
  assert.match(headNote({ customerText: "ありがとうございます", prev: sent }, { COMPOSE_HEAD_SPLIT: "on" }), /^- 頭の一言: はい/);
});
console.log(`compose-head: ${n} pass`);
