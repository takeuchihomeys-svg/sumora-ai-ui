// npx tsx scripts/lib/__tests__/night-capacity.test.ts
// 2026-11-27 作業員L（#803）: 晩の空き枠・流れ残った組・昼の届きの確かめの列の読み
import assert from "node:assert/strict";
import { nightCapacity, leftoverJobs } from "../night-capacity";
import { needsPreflight, preflightKeyOf, switchesOfJob } from "../../exam-preflight-queue";

const c = nightCapacity({ spentUsd: 4.5, jobs: 17, leftover: 2 });
assert.deepEqual([c.avgUsd, c.freeUsd, c.freeJobs], [0.265, 5.5, 20]);
assert.match(c.line, /流れ残った組 2（⚠/);
assert.equal(nightCapacity({ spentUsd: 12, jobs: 3, leftover: 0 }).freeUsd, 0, "上限を超えた晩は空き0");
assert.equal(nightCapacity({ spentUsd: 0, jobs: 0, leftover: 0 }).freeJobs, null);
const ns = Date.parse("2026-11-26T22:00:00+09:00");
assert.equal(leftoverJobs([{ runner: "brain-exam", createdAt: "2026-11-26T10:00:00Z" }, { runner: "brain-exam", createdAt: "2026-11-27T01:00:00Z" }, { runner: "tsc-remote", createdAt: "2026-11-26T10:00:00Z" }, { runner: "cmd", readOnly: true, createdAt: "2026-11-26T10:00:00Z" }], ns), 1, "晩の前に積まれた試験の依頼だけ");
// 列の確かめ
const j = { label: "x", runner: "brain-exam", only: "q1,q2", env: { SW_A: "on", OTHER: "off" } };
assert.equal(needsPreflight(j), true);
assert.equal(needsPreflight({ ...j, preflightMarks: { key: preflightKeyOf(j) } }), false, "同じ問題・同じ env は確かめ直さない");
assert.equal(needsPreflight({ ...j, runner: "tsc-remote" }), false);
assert.deepEqual(switchesOfJob(j), ["SW_A"]);
assert.deepEqual(switchesOfJob({ label: "y", switch: "SW_B（p1）" }), ["SW_B"]);
console.log("night-capacity ok 10");
