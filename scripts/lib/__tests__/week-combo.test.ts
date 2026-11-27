// npx tsx scripts/lib/__tests__/week-combo.test.ts
// 2026-11-26 作業員L（台帳 #799 ⑤）: その週に on にした直しを全部 on にした組を週1回
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextSunday, roundRobin, weekComboOf } from "../week-combo";
import { parseCandidateBlocks } from "../exam-worth";
import { resultProblemsOf } from "../../plan-week-combo";
import { nightZeroCostSteps } from "../exam-night-jobs";

assert.equal(nextSunday("2026-11-26"), "2026-11-29");
assert.equal(nextSunday("2026-11-26", "2026-11-30"), "2026-12-06", "11/30 以降の日曜");
assert.equal(nextSunday("2026-12-06"), "2026-12-06");
assert.deepEqual(roundRobin([["a", "b", "c"], ["d"], ["a", "e"]], 4), ["a", "d", "b", "e"], "直しごとに順に・重なりは1つ");
assert.deepEqual(roundRobin([[], []], 3), []);
const fx = [
  { switchName: "A_ON", itemId: 1, onAt: "2026-11-21T01:00:00Z", eff: ["q101", "q102", "q103"], guards: ["q109"] },
  { switchName: "B_ON", itemId: 2, onAt: "2026-11-24T01:00:00Z", eff: ["q104"], guards: ["q108", "q101"] },
  { switchName: "C_ON", itemId: 3, onAt: "2026-11-25T01:00:00Z", eff: [], guards: [] },
];
const c = weekComboOf(fx, { day: "2026-11-26", baseRef: "abc123", notBefore: "2026-11-30", maxEff: 3 })!;
assert.deepEqual([c.name, c.switches, c.eff, c.guards], ["week-combo-2026-12-06", ["A_ON", "B_ON", "C_ON"], ["q101", "q104", "q102"], ["q109", "q108"]]);
assert.ok(c.fits && c.usd > 0 && c.usd < 1);
assert.equal(weekComboOf(fx.slice(0, 1), { day: "2026-11-26", baseRef: null }), null, "1本だけの週は作らない");
assert.equal(weekComboOf(fx, { day: "2026-11-26", baseRef: null, capUsd: 0.01 })!.fits, false, "晩の上限を超える");
// 係の候補の形で読める（parseCandidateBlocks）
const pb = parseCandidateBlocks(c.block.split("\n"));
assert.deepEqual([pb[0].name.split(" ")[0], pb[0].switches, pb[0].eff, pb[0].guards, pb[0].stage], ["week-combo-2026-12-06", ["A_ON", "B_ON", "C_ON"], ["q101", "q104", "q102"], ["q109", "q108"], "brain"]);
assert.match(c.block, /--baseline=main@abc123/);
// 係の結果のファイル
const dir = mkdtempSync(join(tmpdir(), "wc-"));
writeFileSync(join(dir, "a.json"), JSON.stringify({ switch: "A_ON", only: "q101,q102,q107", guards: ["q107"], at: "2026-11-21" }));
writeFileSync(join(dir, "b.json"), JSON.stringify({ switch: "A_ONX", only: "q105", at: "2026-11-22" }));
assert.deepEqual(resultProblemsOf(dir, "A_ON"), { eff: ["q101", "q102"], guards: ["q107"] });
assert.ok(nightZeroCostSteps("C:/x/m/route.json").some((s) => s.args[0] === "scripts/plan-week-combo.ts" && s.args.includes("--weekly") && s.args.includes("--write=../../../memory/night_bundle_candidates.md")), "晩の費用0の仕事（土曜だけ作る）");
assert.equal(weekComboOf(fx, { day: "2026-11-26", baseRef: null, night: "2026-11-30" })!.name, "week-combo-2026-11-30", "晩を手で決める");
console.log("week-combo: ok 14");
