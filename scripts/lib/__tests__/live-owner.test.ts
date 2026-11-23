// npx tsx scripts/lib/__tests__/live-owner.test.ts
// 2026-11-22 作業員N2（統括役の頼み）: 持ち主を今いる作業員に読み替える表
// 2026-11-23: 4人体制（P・A・L・N2）。昔の名前は付け替え先へ（K2→P・M→A・H→N2・G→L・N→N2・R→A・K→P）
import assert from "node:assert/strict";
import { currentOwnerOf, LIVE_WORKERS } from "../live-owner";

assert.deepEqual([...LIVE_WORKERS].sort(), ["作業員A", "作業員L", "作業員N2", "作業員P"].sort());
for (const [old, now] of [["作業員K2", "作業員P"], ["作業員M", "作業員A"], ["作業員H", "作業員N2"], ["作業員G", "作業員L"], ["作業員N", "作業員N2"], ["作業員R", "作業員A"], ["作業員K", "作業員P"]]) assert.equal(currentOwnerOf(old), now, `${old}→${now}`);
assert.equal(currentOwnerOf("作業員1"), "作業員L");
assert.equal(currentOwnerOf("作業員25"), "作業員L");
for (const w of ["作業員P", "作業員A", "作業員L", "作業員N2"]) assert.equal(currentOwnerOf(w), w, "今いる作業員はそのまま");
assert.equal(currentOwnerOf("作業員N・作業員L"), "作業員N2", "複数なら先の名前を付け替えた今の作業員");
assert.equal(currentOwnerOf("作業員K2・作業員L"), "作業員P");
assert.equal(currentOwnerOf("作業員L（要件は作業員M・next_send は作業員I）"), "作業員L", "括弧の注記は見ない");
assert.equal(currentOwnerOf("作業員22", "tool_rank.star"), "作業員P", "もういない作業員は行の段の持ち主");
assert.equal(currentOwnerOf("作業員22", "writer.reply"), "作業員A");
assert.equal(currentOwnerOf("作業員9", "rag.knowledge"), "統括役", "段でも決まらなければ統括役");
assert.equal(currentOwnerOf("作業員16"), "統括役");
assert.equal(currentOwnerOf("read"), "作業員L", "段の鍵");
assert.equal(currentOwnerOf("check"), "作業員N2");
assert.equal(currentOwnerOf("統括役"), "統括役");
assert.equal(currentOwnerOf(null), "統括役");
console.log("live-owner: ok");
