// npx tsx app/lib/__tests__/example-db-guard.test.ts
// 2026-11-20 作業員L: 手本の保存（片割れ）と見積の読み取り（JSON の後ろの余計な文字）の守り。本番のエラーの形をそのまま使う
import assert from "node:assert/strict";
import { clipChars, firstJsonObject, exampleDbGuardOn, estimateJsonFirstObjectOn } from "../example-db-guard";
import { sanitizeJsonForDb } from "../db-json-sanitize";

// スイッチは既定 on
assert.equal(exampleDbGuardOn({}), true);
assert.equal(exampleDbGuardOn({ EXAMPLE_DB_JSON_GUARD: "off" }), false);
assert.equal(estimateJsonFirstObjectOn({}), true);
assert.equal(estimateJsonFirstObjectOn({ ESTIMATE_JSON_FIRST_OBJECT: "off" }), false);

// ① 文字の単位で切る: 絵文字を途中で切らない（.slice(0, 3) は片割れを残す）
const t = "よろしく😊お願い";
assert.ok(/[\uD800-\uDBFF]$/.test(t.slice(0, 5)));          // 今までの切り方は片割れが残る
assert.equal(clipChars(t, 5), "よろしく😊");
assert.equal(clipChars(null, 3), "");

// ① 書く直前の守り: 手本の行（本文・tpoDebug・ai_components）の片割れだけ落ち、正しい絵文字は残る。直した欄が分かる
const row = {
  customer_message: "ありがとうございます😊",
  sent_reply: "ご査収頂きありがとうございます！！" + "😌".slice(0, 1),
  ai_components: { closing: "何卒よろしくお願い致します✨" },
  reply_context_snapshot: { stance_sent_lite: { head: "ご確認ありがとうございます🌟".slice(0, 14) } },
};
const safe = sanitizeJsonForDb(row);
assert.equal(safe.fixed, true);
assert.equal(safe.value.customer_message, "ありがとうございます😊");
assert.equal(safe.value.sent_reply, "ご査収頂きありがとうございます！！");
assert.equal(safe.value.ai_components.closing, "何卒よろしくお願い致します✨");
assert.deepEqual(safe.fix.paths, ["sent_reply", "reply_context_snapshot.stance_sent_lite.head"]);
assert.doesNotThrow(() => JSON.parse(JSON.stringify(safe.value)));
assert.equal(sanitizeJsonForDb({ a: "😊" }).fixed, false);

// ② 本番の形（11/20 16:55 JST・position 1300 line 37）: JSON の後ろに2つ目の {…} と説明が付いていた
const obj = `{
  "propertyName": "Mele Hou",
  "roomNumber": "102",
  "customerName": "",
  "moveInMonth": 0,
  "rent": 70000,
  "managementFee": 5000,
  "guarantee": 25000,
  "guaranteeRate": 50,
  "monthlyGuaranteeFee": 900,
  "insurance": 18000,
  "keyExchange": 22000,
  "note": "鍵交換 {税込} を含む"
}`;
const raw = `${obj}\n{\n  "補足": "家賃保証料は初回のみ"\n}\n※ 読み取れない項目は 0 にしました`;
assert.throws(() => JSON.parse(raw.match(/\{[\s\S]*\}/)![0]));            // 今までの読み方は落ちる
const got = firstJsonObject(raw);
assert.equal(got, obj);
assert.equal(JSON.parse(got!).keyExchange, 22000);
assert.equal(JSON.parse(got!).note, "鍵交換 {税込} を含む");               // 文字列の中の括弧は数えない
assert.equal(firstJsonObject("```json\n{\"a\":\"x\\\"}\"}\n```"), "{\"a\":\"x\\\"}\"}"); // \" の後の } も文字列の中
assert.equal(firstJsonObject("前置き {\"a\":1"), null);                    // 閉じていなければ null（今までの道に戻る）
assert.equal(firstJsonObject("JSON なし"), null);

console.log("example-db-guard: ok");
