// npx tsx scripts/lib/__tests__/live-owner.test.ts
// 2026-11-22 作業員N2（統括役の頼み）: 持ち主を今いる作業員に読み替える表
import assert from "node:assert/strict";
import { currentOwnerOf } from "../live-owner";

assert.equal(currentOwnerOf("作業員K"), "作業員K2");
assert.equal(currentOwnerOf("作業員1"), "作業員L");
assert.equal(currentOwnerOf("作業員25"), "作業員L");
assert.equal(currentOwnerOf("作業員H"), "作業員H", "今いる作業員はそのまま");
assert.equal(currentOwnerOf("作業員H・作業員K"), "作業員H", "複数なら先の今いる作業員");
assert.equal(currentOwnerOf("作業員4・作業員K"), "作業員L");
assert.equal(currentOwnerOf("作業員L（要件は作業員M・next_send は作業員I）"), "作業員L", "括弧の注記は見ない");
assert.equal(currentOwnerOf("作業員22", "tool_rank.star"), "作業員K2", "もういない作業員は行の段の持ち主");
assert.equal(currentOwnerOf("作業員9", "rag.knowledge"), "統括役", "段でも決まらなければ統括役");
assert.equal(currentOwnerOf("作業員16"), "統括役");
assert.equal(currentOwnerOf("read"), "作業員L", "段の鍵");
assert.equal(currentOwnerOf("統括役"), "統括役");
assert.equal(currentOwnerOf(null), "統括役");
console.log("live-owner: ok");
