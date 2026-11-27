// 2026-11-26 作業員L: 追客・見積→申込の表の純関数
import assert from "node:assert/strict";
import { staffTopicOf, custTypeAfterEstimate, stoneOf, rowsOf } from "../audit-deal-followup";

assert.equal(staffTopicOf("新着でお部屋出てきましたのでお送りします"), "新着");
assert.equal(staffTopicOf("初期費用最大限割引させて頂きます"), "費用");
assert.equal(staffTopicOf("ご都合の良い日に内覧いかがでしょうか"), "内覧の誘い");
assert.deepEqual(custTypeAfterEstimate("家族と相談してみます"), ["家族と相談"]);
assert.deepEqual(custTypeAfterEstimate("ありがとうございます"), ["あいづち"]);
assert.deepEqual(stoneOf("AIX:property_send/one"), { to: [], reply: [], aix: ["property_send"] });
assert.deepEqual(stoneOf("返信・内覧の誘い"), { to: [], reply: ["invite_viewing"], aix: [] });
const r = rowsOf([{ station: "estimate", situation: "s", stone: "返信・費用", reached: true, takeuchi: true }, { station: "estimate", situation: "s", stone: "返信・費用", reached: false, takeuchi: false }]);
assert.equal(r.length, 1); assert.equal(r[0].n, 2); assert.equal(r[0].reached, 1); assert.equal(r[0].takeuchi, 1);
console.log("deal-followup ok 11");
