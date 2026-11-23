// npx tsx scripts/lib/__tests__/exam-worse-single.test.ts
// 2026-11-23 作業員N2: 確かな悪化のうち前も今も1回ずつの比べに印を付ける（分け方は変えない）
import assert from "node:assert/strict";
import { splitWorse } from "../exam-conductor-core";
import type { RowLite } from "../exam-conductor-core";

const row = (id: string, pass: boolean) => ({ id, score: { pass } }) as unknown as RowLite;
const r1 = splitWorse([row("q094", false)], [row("q094", true)], new Set());
assert.equal(r1.sure.length, 1, "1回ずつでも確かな悪化のまま（分け方は変えない）");
assert.match(r1.sure[0].why, /1回ずつ/);
const r3 = splitWorse([row("q197", true), row("q197", false), row("q197", false)], [row("q197", true), row("q197", true), row("q197", true)], new Set());
assert.equal(r3.sure.length, 1);
assert.doesNotMatch(r3.sure[0].why, /1回ずつ/, "3回の比べには印を付けない");
process.env.EXAM_WORSE_SINGLE_MARK = "off";
assert.doesNotMatch(splitWorse([row("q094", false)], [row("q094", true)], new Set()).sure[0].why, /1回ずつ/);
console.log("exam-worse-single: ok");
