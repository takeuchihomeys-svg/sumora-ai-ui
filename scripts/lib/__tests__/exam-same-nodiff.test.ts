// npx tsx scripts/lib/__tests__/exam-same-nodiff.test.ts
import assert from "node:assert/strict";
import { sameNoDiffMode, sameKeyOf, prevSameOf, sameNoDiffVerdict, sameNoDiffMorningLine } from "../exam-same-nodiff";

assert.equal(sameNoDiffMode({}), "shadow", "既定は記録だけ（止めない）");
assert.equal(sameNoDiffMode({ EXAM_SAME_NO_DIFF_GATE: "on" }), "on");
assert.equal(sameNoDiffMode({ EXAM_SAME_NO_DIFF_GATE: "off" }), "off");
// 組の鍵: スイッチと問題の順は問わない・off の値は数えない・tsc は対象外
assert.equal(sameKeyOf({ label: "x", runner: "brain-exam", env: { B: "on", A: "on", C: "off" }, only: "q2,q1" }), "A=on&B=on|q1,q2");
assert.equal(sameKeyOf({ label: "x", runner: "tsc-remote", env: { A: "on" }, only: "q1" }), null);
assert.equal(sameKeyOf({ label: "x", runner: "brain-exam", env: {}, only: "q1" }), null);
const now = Date.parse("2026-11-28T14:00:00Z");
const cand = { label: "a-dict-1128-p1", runner: "brain-exam", env: { AIX_DICTIONARY_LINE: "on" }, only: "q123,q198" };
const nodiff = { worse: 0, better: 0, worseSure: [], worseFlake: [] };
const prev = [
  { job: { label: "a-dict-1127-p1", runner: "brain-exam", env: { AIX_DICTIONARY_LINE: "on" }, only: "q198,q123", createdAt: "2026-11-27T14:00:00Z" }, result: nodiff },
  { job: { label: "old", runner: "brain-exam", env: { AIX_DICTIONARY_LINE: "on" }, only: "q198,q123", createdAt: "2026-11-25T14:00:00Z" }, result: nodiff },
];
const p = prevSameOf(cand, prev, now);
assert.equal(p?.job.label, "a-dict-1127-p1", "36時間の中の一番新しい同じ組");
// 全部そろえば止める（つもり）
assert.equal(sameNoDiffVerdict(p, 0, []).wouldSkip, true);
// コードの差・材料の元の更新・読めない・差ありは止めない
assert.equal(sameNoDiffVerdict(p, 2, []).wouldSkip, false);
assert.match(sameNoDiffVerdict(p, 0, ["設計知見 3"]).why, /材料の元が更新（設計知見 3）/);
assert.equal(sameNoDiffVerdict(p, 0, ["設計知見 3"]).wouldSkip, false);
assert.equal(sameNoDiffVerdict(p, null, []).wouldSkip, false);
assert.equal(sameNoDiffVerdict(p, 0, null).wouldSkip, false);
assert.equal(sameNoDiffVerdict({ ...p!, result: { worse: 0, better: 1, worseSure: [], worseFlake: [] } }, 0, []).wouldSkip, false, "前が良くなった組は止めない");
assert.equal(sameNoDiffVerdict(null, 0, []).wouldSkip, false);
// 朝の1枚の1行
const ln = sameNoDiffMorningLine([
  { at: "2026-11-28T13:00:00Z", label: "a-dict-1128-p1", prevLabel: "a-dict-1127-p1", wouldSkip: true, mode: "shadow", planUsd: 0.37, why: "" },
  { at: "2026-11-28T13:10:00Z", label: "b", prevLabel: null, wouldSkip: false, mode: "shadow", planUsd: null, why: "" },
  { at: "2026-11-26T13:10:00Z", label: "old", prevLabel: null, wouldSkip: true, mode: "shadow", planUsd: 9, why: "" },
], now);
assert.equal(ln, "- 差なしの組の関所（#803 ③・EXAM_SAME_NO_DIFF_GATE=shadow・前の24時間）: 見た組 2・止めたつもり 1（見込み $0.37）｜a-dict-1128-p1←a-dict-1127-p1");
assert.equal(sameNoDiffMorningLine([], now), null);
console.log("exam-same-nodiff ok 19");
