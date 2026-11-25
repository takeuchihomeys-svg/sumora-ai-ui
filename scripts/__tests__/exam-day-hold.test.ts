// 2026-11-26 作業員L: DeepSeek の試験は昼（JST 8〜22時）は流さない（examDayHoldWhy）・関所は 8時〜翌8時（audit-night-cost の nightWindow "gate"）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { examDayHoldWhy } from "../lib/exam-conductor-core";

const at = (hhmm: string) => new Date(`2026-11-26T${hhmm}:00+09:00`);
const exam = { runner: "brain-exam" };
assert.ok(examDayHoldWhy(exam, at("10:00"), {}), "昼の DeepSeek の試験は止める");
assert.equal(examDayHoldWhy(undefined, at("10:00"), {}), null);
assert.equal(examDayHoldWhy(exam, at("22:00"), {}), null, "22時からは流す");
assert.equal(examDayHoldWhy(exam, at("07:59"), {}), null, "朝 8時までは流す");
assert.ok(examDayHoldWhy(exam, at("08:00"), {}), "8時ちょうどは昼");
assert.equal(examDayHoldWhy({ ...exam, dayOk: true }, at("10:00"), {}), null, "--day-ok は流す");
assert.equal(examDayHoldWhy({ runner: "tsc-remote" }, at("10:00"), {}), null, "tsc-remote は止めない");
assert.equal(examDayHoldWhy({ runner: "cmd", readOnly: true }, at("10:00"), {}), null, "読むだけは止めない");
assert.ok(examDayHoldWhy({ runner: "cmd" }, at("10:00"), {}), "AI を呼ぶ台本は止める");
assert.equal(examDayHoldWhy({ ...exam, env: { EXAM_BRAIN_PROVIDER: "openai" } }, at("10:00"), {}), null, "OpenAI の試験は止めない");
assert.equal(examDayHoldWhy(exam, at("10:00"), { EXAM_DAY_HOLD: "off" }), null, "=off で止める");
// 配線: 係の門・--day-ok の旗・関所の窓
const conductor = readFileSync(join(__dirname, "../exam-conductor.ts"), "utf8"), nightCost = readFileSync(join(__dirname, "../audit-night-cost.ts"), "utf8");
assert.ok(/const dh = examDayHoldWhy\(j, new Date\(\), process\.env\); if \(dh\) return \{ ok: false, why: dh \}/.test(conductor), "係の門");
assert.ok(/flag\("day-ok"\) \? \{ dayOk: true \}/.test(conductor), "--day-ok");
assert.ok(/if \(win === "gate"\) return \[base \+ 8 \* H, base \+ 32 \* H\]/.test(nightCost) && /arg\("gate"\) \? "gate" : "night"/.test(nightCost), "関所は 8時〜翌8時");
console.log("exam-day-hold ok 14");
