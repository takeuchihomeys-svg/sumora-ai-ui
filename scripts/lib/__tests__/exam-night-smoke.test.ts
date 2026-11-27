// npx tsx scripts/lib/__tests__/exam-night-smoke.test.ts
// 2026-11-26 作業員L（台帳 #799 ①②）: 晩の最初の煙の1問・流す時の関所（効く問題の当て先）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { smokeDue, smokeProblemOf, smokeVerdictOf, smokeHoldWhy, smokeMorningLine, type SmokeMark } from "../exam-night-smoke";
import { preflightReachOf, runReachSplit, runReachOn } from "../exam-preflight-reach";
import { nightKeyOf } from "../exam-night-jobs";

const night = Date.parse("2026-11-26T23:30:00+09:00");
const key = nightKeyOf(night);
assert.equal(key, nightKeyOf(Date.parse("2026-11-27T06:30:00+09:00")), "22時と翌朝は同じ晩");
// ① 流すか
assert.equal(smokeDue({ runner: "brain-exam", only: "q1,q2" }, null, night).due, true);
assert.equal(smokeDue({ runner: "brain-exam", only: "q1" }, { key }, night).due, false, "この晩はもう流した");
assert.equal(smokeDue({ runner: "cmd", only: "" }, null, night).due, false, "試験の依頼でない");
assert.equal(smokeDue({ runner: "brain-exam", only: "" }, null, night).due, false, "問題の無い rag は流さない");
assert.equal(smokeDue({ runner: "brain-exam", only: "q1" }, null, night, { EXAM_NIGHT_SMOKE: "off" }).due, false);
assert.equal(smokeDue({ runner: "brain-exam", only: "q1" }, null, Date.parse("2026-11-26T14:00:00+09:00")).due, false, "昼（--day-ok）は流さない");
assert.equal(smokeProblemOf(["q1", "q2"], ["q1"]), "q2", "守りでない問題");
assert.equal(smokeProblemOf(["q1"], ["q1"]), "q1");
// ① 出力の読み（11/25 の晩の形: 集計は出たのにブレイン0回）
const blockedOut = [
  "=== この回の API（試験の道具の数え・replay）===", "  新しく呼んだ   0回 $0.0000", "  名札ごと（呼んだ/再生/止めた）: final_check 1/0",
  "=== llm_usage_logs（route=script:brain-exam・この回）: 1行 ===", "    1回 $0.0010  final_check deepseek-chat", "  Claude 0回 $0.0000／DeepSeek・Jev 等 1回 $0.0010／止めた 3回",
  "⛔ テストの歯止めで止めた呼び出し 3回（上のログの理由を読んで直す）:", "  場面の網: 審査の言葉（出所）",
].join("\n");
const v1 = smokeVerdictOf(blockedOut);
assert.deepEqual([v1.ok, v1.brainCalls, v1.blocked], [false, 0, 3]);
assert.match(v1.why, /出所/);
const okOut = "=== この回の API（試験の道具の数え・record）===\n  名札ごと（呼んだ/再生/止めた）: brain_full 1/0・brain_fresh 0/1・final_check 1/0\n  Claude 0回 $0／DeepSeek・Jev 等 2回 $0.01／止めた 0回";
assert.deepEqual([smokeVerdictOf(okOut).ok, smokeVerdictOf(okOut).brainCalls], [true, 2]);
const noCas = "=== llm_usage_logs（route=x・この回）: 2行 ===\n    2回 $0.0100  brain_full deepseek-chat\n    1回 $0.0000  brain_full deepseek-chat status=500\n  止めた 0回";
assert.equal(smokeVerdictOf(noCas).brainCalls, 2, "道具の数えが無ければ llm_usage_logs の行（status の付く行は数えない）");
assert.equal(smokeVerdictOf("Error: 落ちた").ok, null, "集計が無い＝分からない（止めない）");
// ① 関所と毎朝の1枚
const mark: SmokeMark = { key, at: "", ok: false, why: v1.why, brainCalls: 0, blocked: 3, label: "smoke", job: "j", problem: "q2" };
assert.match(smokeHoldWhy({ runner: "brain-exam" }, mark, night) ?? "", /煙の1問で止めた/);
assert.match(smokeHoldWhy({ runner: "cmd" }, mark, night) ?? "", /煙/, "試験の台本の依頼も止める");
assert.equal(smokeHoldWhy({ runner: "tsc-remote" }, mark, night), null, "tsc は止めない");
assert.equal(smokeHoldWhy({ runner: "cmd", readOnly: true }, mark, night), null, "読むだけは止めない");
assert.equal(smokeHoldWhy({ runner: "brain-exam" }, mark, Date.parse("2026-11-27T23:00:00+09:00")), null, "次の晩は止めない");
assert.equal(smokeHoldWhy({ runner: "brain-exam" }, { ...mark, ok: true }, night), null);
assert.match(smokeMorningLine(mark, Date.parse("2026-11-27T06:40:00+09:00")), /⚠ 止めた/);
assert.match(smokeMorningLine({ ...mark, ok: true, why: "ブレイン 2回届いた" }, night), /通った/);
assert.match(smokeMorningLine(null, night), /流れていない/);
// ② 流す時の関所
const prior = new Map<string, Record<string, number>>([["q1", { sent_facts: 1 }], ["q2", { sent_image_properties: 3 }], ["q3", {}]]);
const pr = preflightReachOf(["SIP_JUDGE"], ["q1", "q2", "q3", "q9"], prior);
const s1 = runReachSplit(pr, ["q1", "q2", "q3", "q9"], []);
assert.deepEqual([s1.toGuard, s1.effective, s1.stop], [["q1", "q3"], ["q2", "q9"], false], "材料0は守りに・前の回が無い問題は効く問題のまま");
assert.match(s1.line, /守り（1回）に回した/);
const s2 = runReachSplit(preflightReachOf(["SIP_JUDGE"], ["q1", "q3", "q2"], prior), ["q1", "q3", "q2"], ["q2"]);
assert.deepEqual([s2.toGuard, s2.stop], [["q1", "q3"], true], "効く問題が全部材料0＝流さない（守りは数えない）");
assert.deepEqual(runReachSplit([], ["q1"], []).toGuard, [], "材料の要るスイッチが無ければ見ない");
assert.equal(runReachOn({ EXAM_RUN_REACH: "off" }), false);
// 配線（係の中）
const src = readFileSync(join(__dirname, "../../exam-conductor.ts"), "utf8");
assert.ok(/smokeHoldWhy\(j, readJson<SmokeMark \| null>\(join\(MARKS, SMOKE_MARK_FILE\)/.test(src), "関所が印を読む");
assert.ok(/runReachSplit\(/.test(src) && /smokeVerdictOf\(/.test(src), "流す時の関所と煙の1問が runJob に入る");
const si = readFileSync(join(__dirname, "../../self-improve.ts"), "utf8");
assert.ok(/smokeMorningLine\(/.test(si), "毎朝の1枚に1行");
console.log("exam-night-smoke: ok 31");
