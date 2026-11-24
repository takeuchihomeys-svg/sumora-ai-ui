// 試験の効率の物差し（台帳 #686）の純関数のテスト
import assert from "node:assert/strict";
import { classifyJob, effMetrics, worseNight, proposalFor, type EffJob } from "../exam-efficiency";

assert.equal(classifyJob({ worseSure: [{}] }), "sure");
assert.equal(classifyJob({ better: 2 }), "better");
assert.equal(classifyJob({ worseFlake: [{}] }), "flake");
assert.equal(classifyJob({}), "nodiff");

const J = (label: string, usd: number, cls: EffJob["cls"], guardUsd = 0): EffJob => ({ label, owner: "作業員A", usd, cls, guardUsd });
const good = effMetrics({ jobs: [J("a", 1, "sure"), J("b", 1, "nodiff")], rebuildUsd: 0.2, fixesOn: 4, stoppedUsd: 0.5, totalUsd: 2, matchDelta: null });
assert.equal(good.usdPerFix, 0.5);
assert.equal(good.noDiffShare, 0.5);
assert.equal(good.reasonUsd.rebuild, 0.2);
const bad = effMetrics({ jobs: [J("c", 3, "nodiff"), J("d", 1, "flake", 0.3)], rebuildUsd: 0.2, fixesOn: 1, stoppedUsd: 0, totalUsd: 4, matchDelta: null });
const w = worseNight(bad, [good, good]);
assert.equal(w.worse, true);
assert.equal(w.reason, "nodiff");
assert.ok(w.why.length >= 2);
assert.equal(worseNight(good, [good]).worse, false, "同じなら悪くない");
assert.equal(worseNight(bad, []).worse, false, "前が無ければ言わない");
const zero = effMetrics({ jobs: [J("e", 2, "nodiff")], rebuildUsd: 0, fixesOn: 0, stoppedUsd: 0, totalUsd: 2, matchDelta: null });
assert.ok(worseNight(zero, [good]).why.some((x) => x.includes("直しが0")));
const pr = proposalFor("nodiff", bad.jobs ? [J("c", 3, "nodiff"), J("d", 1, "flake")] : [], "2026-11-24");
assert.equal(pr.owner, "作業員A");
assert.ok(pr.next.includes("c"));
assert.equal(proposalFor("guards", [J("d", 1, "flake", 0.3)], "2026-11-24").owner, "作業員L");
console.log("exam-efficiency: ok");
