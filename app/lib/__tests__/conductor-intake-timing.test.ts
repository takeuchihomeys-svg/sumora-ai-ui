// 台帳 #749（作業員L 11/26）: 入口の読みが判断に間に合わない所の直し（字数の上限・前の読みの使い回し・時刻の記録）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { intakeMaxTokens, intakeReusePrev, INTAKE_REUSE_MAX_MS } from "../conductor-intake";

// 字数の上限: 既定は今と同じ（重点あり 450・無し 300）・=on で広げる
assert.equal(intakeMaxTokens(true, {}), 450);
assert.equal(intakeMaxTokens(false, {}), 300);
assert.equal(intakeMaxTokens(true, { CONDUCTOR_INTAKE_MAX_TOKENS_WIDE: "on" }), 700);
assert.equal(intakeMaxTokens(false, { CONDUCTOR_INTAKE_MAX_TOKENS_WIDE: "on" }), 450);

// 使い回し: 既定 off・同じお客様の番・その番が 10分以内の時だけ
const ts = "2026-11-26T01:00:00.000Z", now = Date.parse(ts) + 3 * 60_000;
const ON = { CONDUCTOR_INTAKE_REUSE_PREV: "on" };
assert.equal(intakeReusePrev({ prevAnalyzedTs: ts, prevAt: ts, nowCustomerTs: ts, nowMs: now, env: {} }), false, "既定 off");
assert.equal(intakeReusePrev({ prevAnalyzedTs: ts, prevAt: ts, nowCustomerTs: ts, nowMs: now, env: ON }), true);
assert.equal(intakeReusePrev({ prevAnalyzedTs: ts, prevAt: ts, nowCustomerTs: "2026-11-26T01:02:00.000Z", nowMs: now, env: ON }), false, "新しい通が来た");
assert.equal(intakeReusePrev({ prevAnalyzedTs: ts, prevAt: ts, nowCustomerTs: ts, nowMs: Date.parse(ts) + INTAKE_REUSE_MAX_MS + 1, env: ON }), false, "古すぎる");
assert.equal(intakeReusePrev({ prevAnalyzedTs: null, prevAt: null, nowCustomerTs: ts, nowMs: now, env: ON }), false);

// 配線
const core = readFileSync(join(__dirname, "../brain-core.ts"), "utf8"), server = readFileSync(join(__dirname, "../conductor-intake-server.ts"), "utf8"), layers = readFileSync(join(__dirname, "../brain-layers.ts"), "utf8");
assert.ok(/intakeMaxTokens\(focusOn\)/.test(server), "入口の上限は intakeMaxTokens");
assert.ok(/intakeStartMs = Date\.now\(\) - coreT0;\n\s*intakeP = import/.test(core.replace(/\r\n/g, "\n")), "入口を始めた時刻");
assert.ok(/intake_timing: intakeTimingRec/.test(core) && /o.itm = /.test(layers), "記録の欄");
assert.ok(/run\?\.answer \?\? \(reused \?/.test(core), "使い回しは今の答えが無い時だけ");
console.log("conductor-intake-timing ok 14");
