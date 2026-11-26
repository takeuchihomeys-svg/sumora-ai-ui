// npx tsx scripts/lib/__tests__/exam-dictionary.test.ts
// 2026-11-27 作業員L（台帳 #803 試験の辞書）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flakeOf, materialsOf, buildDictionary, dictSelect, dictEval, examDictionaryMode } from "../exam-dictionary";
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
console.log("exam-dictionary: ok 18");
