// 試験の削りの「質を落とさない線」（台帳 #686 の③）と振り分けの案（#670）の純関数のテスト
import assert from "node:assert/strict";
import { decideOff, missedOf } from "../exam-cut-guard";
import { targetOf } from "../llm-route-plan";

assert.deepEqual(missedOf("narrow", { missed: ["a:q1"] }), ["a:q1"]);
assert.deepEqual(missedOf("reps", { ruleMissed: [] }), []);
assert.equal(decideOff("narrow", [], {}).off, false);
assert.equal(decideOff("narrow", ["a:q1"], {}).off, true, "見落としが出たら止める");
assert.equal(decideOff("narrow", ["a:q1"], { EXAM_NARROW: "off" }).off, false, "もう off なら書かない");
assert.equal(decideOff("guards", ["x"], {}).off, false, "守りは止めずに数だけ");

assert.equal(targetOf("A", "/api/generate-reply", "reply_generate_claude_writer", "claude-sonnet-5-5").to, "claude");
assert.equal(targetOf("B", "/api/generate-reply", "reply_generate_claude_writer", "claude-sonnet-5-5").to, "deepseek");
assert.equal(targetOf("A", "/api/cron/brain-sweep", "brain_fresh", "claude-sonnet-5-5").to, "gpt-6.2-sol");
assert.equal(targetOf("A", "/api/generate-draft-bg-async", "brain_fresh", "claude-sonnet-5-5").to, "claude", "本番のブレインは Claude");
assert.equal(targetOf("A", "/api/generate-reply", "final_check_rule_check", "claude-haiku-4-5-20251001").to, "gpt-6-luna");
assert.equal(targetOf("A", "/api/line-webhook", "webhook_image_vision", "claude-haiku-4-5-20251001").to, "claude", "画像は Claude");
assert.equal(targetOf("A", "/api/cron/brain-sweep", "reply_writer_warm", "claude-sonnet-5-5").to, "claude");
console.log("exam-cut-guard・llm-route-plan: ok");
