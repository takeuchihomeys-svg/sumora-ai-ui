// npx tsx scripts/lib/__tests__/exam-preflight-marks.test.ts
// 2026-11-27 作業員L（#803）: 昼に LLM を呼ばずに部品が届くかを確かめる
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { preflightKeysOf, preflightVerdict, targetMarksOf } from "../../exam-preflight-marks";

const out = 'x\n[preflight-marks] {"conv":"c","keys":["core_ledger","pickup_promise_flow"]}\ny\n[preflight-marks] {"conv":"c","keys":[]}\n';
assert.deepEqual(preflightKeysOf(out), [["core_ledger", "pickup_promise_flow"], []]);
assert.deepEqual(preflightKeysOf("なし"), []);
const v = preflightVerdict({ q1: ["a"], q2: ["a", "b"], q3: [], q4: null }, ["a"], 3);
assert.deepEqual([v.reached, v.notReached, v.unknown, v.verdict], [["q1", "q2"], ["q3"], ["q4"], "届かず"], "届いた 2 < 3");
{ const w = preflightVerdict({ q1: ["a"], q2: ["a"], q3: [] }, ["a"], 3, { q3: 2 }); assert.deepEqual([w.noRecord, w.notReached, w.verdict], [["q3"], [], "録音なし"], "録音の無い前段の読みで届かなかった問題は録音なし（届かずと混ぜない）"); }
assert.equal(preflightVerdict({ q1: ["a"], q2: ["a"], q3: ["a"] }, ["a"], 3).verdict, "比べる");
assert.equal(preflightVerdict({ q1: ["a"] }, ["a"], 3).verdict, "比べる", "問題が3未満の組は全部届けば比べる");
assert.equal(preflightVerdict({ q1: ["a"] }, [], 3).verdict, "印なし");
assert.deepEqual(targetMarksOf({ v: 1, builtAt: "", problems: {}, switches: { S: { sw: "S", needs: [], testable: true, why: "", withMaterial: [], hit: [], none: [], marks: [{ mark: "m1", source: "手", n: 0 }, { mark: "m2", source: "推定", n: 3 }] } } }, ["S", "X"]), ["m1"], "手の印があればそれだけ");
const core = readFileSync(join(__dirname, "../../../app/lib/brain-core.ts"), "utf8");
assert.ok(/if \(process\.env\.EXAM_MARKS_PREFLIGHT === "on"\) \{ console\.log\(`\[preflight-marks\]/.test(core) && core.includes('throw new Error("[preflight-marks] 印だけ見る回＝ここで止めた")'), "印を出したらブレインを呼ばずに止める（本番では立たない）");
console.log("exam-preflight-marks ok 10");
