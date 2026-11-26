// npx tsx scripts/lib/__tests__/exam-dictionary.test.ts
// 2026-11-27 作業員L（台帳 #803 試験の辞書）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flakeOf, materialsOf, buildDictionary, dictSelect, dictEval, examDictionaryMode, inferSwitchMarks, dictReachGate } from "../exam-dictionary";
import { nightZeroCostSteps } from "../exam-night-jobs";

// 揺れ: 同じ版×モデルの観測で見る
const o = (sig: string, codeKey = "c1", model = "ds") => ({ sig, at: "2026-11-20", independent: true, codeKey, model });
assert.deepEqual(flakeOf([o("A|○"), o("A|○"), o("B|✕")]), { n: 3, same: 2, share: 0.67, flaky: false });
assert.equal(flakeOf([o("A|○"), o("B|✕"), o("C|✕")]).flaky, true);
assert.equal(flakeOf([o("A|○", "c1"), o("B|✕", "c2"), o("C|✕", "c3")]).flaky, false, "版の違う観測は揺れと数えない");
assert.equal(flakeOf([o("A|○"), o("B|✕")]).flaky, false, "観測が3回未満は決めない");
// 材料: 写しの表の行と前の回の inserted の大きい方
assert.deepEqual(materialsOf({ id: "q1", ledger: { estimate_records: [1, 2], viewings: [] } }, { estimate_records: 1, sent_image_properties: 3 }), { estimate_records: 2, sent_image_properties: 3 });
const d = buildDictionary({
  problems: [{ id: "q1", type: "見積", sub: "cost:x", ledger: { estimate_records: [1] } }, { id: "q2", type: "物件", sub: "pickup", ledger: {} }, { id: "q3", type: "物件", ledger: { estimate_records: [1] } }],
  reach: { BRAIN_ESTIMATE_RECORDS: { needs: ["estimate_records"] }, LEDGER_TASKS: { needs: ["line_tasks"] }, MARK_ONLY: {} },
  learned: { BRAIN_ESTIMATE_RECORDS: { problems: { q3: { v: "none" }, q1: { v: "hit" } } } },
  obsOf: (id) => (id === "q1" ? [o("A|○"), o("B|✕"), o("C|✕")] : [o("A|○")]),
});
assert.deepEqual([d.problems.q1.scene, d.problems.q1.flake.flaky, d.problems.q1.last.pass], ["cost", true, false]);
assert.deepEqual([d.switches.BRAIN_ESTIMATE_RECORDS.testable, d.switches.BRAIN_ESTIMATE_RECORDS.withMaterial], [true, ["q1", "q3"]]);
assert.equal(d.switches.LEDGER_TASKS.testable, false, "材料がどの写しにも無い＝試験できない（先に写し）");
assert.match(d.switches.LEDGER_TASKS.why, /先に写し/);
assert.equal(d.switches.MARK_ONLY.testable, true, "要る材料の行が無いスイッチは写しでは決められない（流す）");
// 選び
const s = dictSelect(d, ["BRAIN_ESTIMATE_RECORDS"], ["q1", "q2", "q3", "q9"], ["q2"]);
assert.deepEqual([s.keep, s.dropNoMaterial, s.dropNone, s.flaky], [["q1", "q2", "q9"], [], ["q3"], ["q1"]], "守りは触らない・前に効かなかった問題は外す・揺れは印だけ");
assert.deepEqual(dictSelect(d, ["BRAIN_ESTIMATE_RECORDS"], ["q2"], []).dropNoMaterial, ["q2"], "材料が写しに無い問題");
assert.deepEqual(dictSelect(d, ["LEDGER_TASKS"], ["q1"], []).untestable, ["LEDGER_TASKS"]);
assert.match(dictSelect(d, ["LEDGER_TASKS"], ["q1"], []).line, /試験できない（先に写し）: LEDGER_TASKS/);
// 物差し
const e = dictEval(d, [{ label: "j1", switches: ["BRAIN_ESTIMATE_RECORDS"], ids: ["q1", "q3"], usd: 0.2, signal: ["q3"] }]);
assert.deepEqual([e.dropped, e.savedUsd, e.missedSignals], [1, 0.1, 1], "外した問題に確かな悪化があれば見落としとして数える");
assert.equal(examDictionaryMode({}), "shadow", "既定は記録だけ");
assert.ok(nightZeroCostSteps("x.json").some((x) => x.args[0] === "scripts/build-exam-dictionary.ts"), "晩の費用0の仕事");
assert.ok(/dictSelect\(dict, onSw, ids, job\.guards \?\? \[\]\)/.test(readFileSync(join(__dirname, "../../exam-conductor.ts"), "utf8")), "積む時に1行");

// 2026-11-27: 推定の印（on の回だけに出て off の回に出ない印）
const inf = inferSwitchMarks([
  { switches: ["SW_A"], rows: [{ id: "q1", marks: ["a_line", "common"] }, { id: "q2", marks: ["a_line"] }] },
  { switches: ["SW_B", "X", "Y", "Z"], rows: [{ id: "q1", marks: ["b_line"] }, { id: "q2", marks: ["b_line"] }] },
], (id) => new Set(id === "q1" ? ["common"] : []));
assert.deepEqual(inf.SW_A, [{ mark: "a_line", source: "推定", n: 2 }], "off に出る印は外す・2問以上");
assert.equal(inf.SW_B, undefined, "同時に on のスイッチが多い組は数えない");
const d2 = buildDictionary({
  problems: [{ id: "q1", ledger: { property_pickups: [{ row: { status: "pending" } }] } }, { id: "q2", ledger: {} }, { id: "q3", ledger: {} }],
  reach: { SW_A: {} }, obsOf: () => [], handMarks: { SW_H: "h_line" }, inferred: inf, onRuns: { SW_A: { q1: true, q2: false } },
  snapshotRule: (sw, l) => (sw === "SW_S" ? !!(l as { property_pickups?: unknown[] } | null)?.property_pickups?.length : null),
});
assert.deepEqual(d2.switches.SW_A.marks, [{ mark: "a_line", source: "推定", n: 2 }]);
assert.deepEqual([d2.switches.SW_A.ranOn, d2.switches.SW_A.marked], [["q1", "q2"], ["q1"]]);
assert.equal(d2.switches.SW_H.marks![0].source, "手", "手の行と推定は分ける");
assert.deepEqual(dictSelect(d2, ["SW_A"], ["q1", "q2", "q3"], []).dropNoReach, ["q2"], "前の on で走ったのに印が出なかった問題（場面が立たない）・前の回が無い q3 は残す");
// 届いたかの関所（A の案と同じ所）
assert.equal(dictReachGate(d2, "SW_A", [{ id: "q1", marks: { a_line: 5 } }, { id: "q2", marks: {} }], ["q1", "q2"], 3).verdict, "届かず");
assert.equal(dictReachGate(d2, "SW_A", [{ id: "q1", marks: { a_line: 5 } }], ["q1"], 1).verdict, "比べる");
assert.equal(dictReachGate(d2, "NO_MARK", [], ["q1"]).verdict, "印なし");
console.log("exam-dictionary: ok 27");
