// npx tsx scripts/lib/__tests__/on-after.test.ts
// 2026-11-26 作業員L（台帳 #799 ④）: on にした直しの試験での差と本番の一致の動き（7日・14日）
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowMean, onGroupsOf, jstDayOf, type DayVal } from "../on-after";
import { examBySwitch } from "../../audit-on-after";
import { nightZeroCostSteps } from "../exam-night-jobs";

const daily = new Map<string, DayVal>();
for (let i = 1; i <= 30; i++) { const d = `2026-11-${String(i).padStart(2, "0")}`; daily.set(d, { value: i < 10 ? 80 : 74, n: 10 }); }
assert.deepEqual(windowMean(daily, "2026-11-03", "2026-11-10"), { mean: 80, n: 70, days: 7 });
assert.equal(windowMean(new Map([["2026-11-01", { value: 50, n: 1 }], ["2026-11-02", { value: 80, n: 3 }]]), "2026-11-01", "2026-11-03").mean, 72.5, "番の数で重み");
assert.equal(jstDayOf("2026-11-09T16:00:00Z"), "2026-11-10", "JST の日");
const ev = [{ itemId: 1, at: "2026-11-10T01:00:00Z", switchName: "A", title: "" }, { itemId: 2, at: "2026-11-10T03:00:00Z", switchName: "B", title: "" }];
const exam = new Map([["A", { better: 2, worse: 0, labels: ["a1"] }], ["B", { better: 1, worse: 0, labels: ["b1"] }]]);
const g = onGroupsOf(ev, exam, daily, "2026-11-30");
assert.equal(g.length, 1, "同じ日の on は1つの組");
assert.deepEqual([g[0].switches, g[0].exam.better, g[0].before, g[0].after7, g[0].d7, g[0].d14, g[0].verdict], [["A", "B"], 3, 80, 74, -6, -6, "miss"], "試験は良く・本番は 6pt 下がった＝外れ");
assert.equal(onGroupsOf(ev, exam, daily, "2026-11-12")[0].verdict, "wait", "7日経っていない");
assert.equal(onGroupsOf(ev, exam, daily, "2026-11-30", { minN: 100 })[0].verdict, "flat", "番が少ない");
assert.equal(onGroupsOf(ev, new Map(), daily, "2026-11-30")[0].verdict, "no_exam");
assert.equal(onGroupsOf(ev, new Map([["A", { better: 1, worse: 1, labels: ["x"] }]]), daily, "2026-11-30")[0].verdict, "flat", "試験で悪化のあった組は外れにしない");
const up = new Map(daily); for (let i = 10; i <= 30; i++) up.set(`2026-11-${i}`, { value: 83, n: 10 });
assert.equal(onGroupsOf(ev, exam, up, "2026-11-30")[0].verdict, "hit");
assert.equal(onGroupsOf(ev, exam, daily, "2026-11-20")[0].d14, null, "14日経っていなければ d14 なし");
// 係の結果のファイル
const dir = mkdtempSync(join(tmpdir(), "onafter-"));
writeFileSync(join(dir, "x1.json"), JSON.stringify({ label: "x1", switch: "A（p1: A,C）", better: 2, worse: 0 }));
writeFileSync(join(dir, "x2.json"), JSON.stringify({ label: "x2", switch: "AB", better: 9, worse: 9 }));
writeFileSync(join(dir, "x3.reps.json"), JSON.stringify({ q1: 1 }));
const eb = examBySwitch(dir, ["A"]);
assert.deepEqual(eb.get("A"), { better: 2, worse: 0, labels: ["x1"] }, "名前の一致は区切りで（AB は A ではない）");
assert.ok(nightZeroCostSteps("x.json").some((s) => s.args[0] === "scripts/audit-on-after.ts" && s.args.includes("--write")), "晩の費用0の仕事で毎晩");
console.log("on-after: ok 13");
