// npx tsx scripts/lib/__tests__/claude-split-learned.test.ts
// 2026-11-26 作業員L（台帳 #799 ③）: 本番と試験の割れの型の表を毎晩育てる
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitFamiliesOf, learnedScenesOf, mergeSplitScenes, loadLearnedSplit, alignByHead, type LearnedSplitFile } from "../claude-split-learned";
import { SPLIT_SCENES, scenesOfProblem } from "../claude-check-gate";
import { famOfCode } from "../../build-claude-split";
import { nightZeroCostSteps } from "../exam-night-jobs";

// 系統ごとの一致（11/25 の形: DeepSeek 返信 → Claude AIX が割れ）
const rows = [
  ...["q1", "q2", "q3", "q4", "q5"].flatMap((id, i) => [{ id, claude: true, fam: "確認" }, { id, claude: false, fam: i < 2 ? "返信" : "確認" }]),
  { id: "q6", claude: true, fam: "内覧" }, { id: "q6", claude: false, fam: "内覧" },
  { id: "q7", claude: false, fam: "見積" },
];
const f = splitFamiliesOf(rows);
assert.deepEqual(f["確認"], { agree: 3, n: 5 });
assert.deepEqual(f["返信"], { agree: 0, n: 2 }, "割れた問題は両方の系統で数える");
assert.equal(f["見積"], undefined, "Claude の行の無い問題は数えない");
const sc = learnedScenesOf(f, "2026-11-26");
assert.deepEqual(sc.map((s) => [s.families[0], s.rate, s.n]), [["確認", 0.6, 5]]);
assert.equal(learnedScenesOf({ 返信: { agree: 0, n: 9 } }, "d").length, 0, "返信は型にしない");
assert.equal(learnedScenesOf({ 確認: { agree: 9, n: 10 } }, "d").length, 0, "割れが小さい系統は型にしない");
assert.equal(learnedScenesOf({ 確認: { agree: 1, n: 4 } }, "d").length, 0, "n が足りない");
// 重ね方
const L = (fams: LearnedSplitFile["families"], scenes = learnedScenesOf(fams, "d")): LearnedSplitFile => ({ v: 1, builtAt: "", minN: 5, maxRate: 0.85, families: fams, scenes });
assert.deepEqual(mergeSplitScenes(SPLIT_SCENES, null), SPLIT_SCENES, "覚えた表が無ければ手の表");
const m1 = mergeSplitScenes(SPLIT_SCENES, L({ 確認: { agree: 9, n: 10 }, 物件: { agree: 1, n: 2 } }));
assert.deepEqual(m1.map((s) => s.families), [["物件"]], "覚えた表で割れが小さい系統（確認）は外れる・n の足りない系統（物件）は手の表のまま");
const m2 = mergeSplitScenes(SPLIT_SCENES, L({ 見積: { agree: 2, n: 6 } }));
assert.ok(m2.some((s) => s.id === "learned_見積") && m2.some((s) => s.families.includes("確認")), "新しい割れの型が足される");
assert.equal(scenesOfProblem({ id: "x", accept: ["AIX:estimate_sheet"] }, m2).length, 1, "見積の問題が関所に掛かる");
assert.equal(loadLearnedSplit("無いファイル.json"), null);
assert.equal(loadLearnedSplit("無いファイル.json", { CLAUDE_SPLIT_LEARNED: "off" }), null);
// 道の系統・晩の仕事
assert.equal(famOfCode("AIX:property_check_result"), "確認");
assert.equal(famOfCode("two_stage_promise"), "返信");
assert.ok(nightZeroCostSteps("x.json").some((s) => s.args[0] === "scripts/build-claude-split.ts"), "晩の費用0の仕事で毎晩");
assert.ok(/table: readonly SplitScene\[\] = splitScenesNow\(\)/.test(readFileSync(join(__dirname, "../claude-check-gate.ts"), "utf8")), "関所が重ねた表を使う");
// 版をそろえる（A の勧め・統括役の決め: 一番新しい版の行で比べる）
const ar = alignByHead([
  { id: "a", claude: true, fam: "確認", head: "old", at: 1 }, { id: "a", claude: true, fam: "返信", head: "new", at: 9 },
  { id: "a", claude: false, fam: "確認", head: "old", at: 1 }, { id: "a", claude: false, fam: "返信", head: "new", at: 8 },
  { id: "b", claude: true, fam: "確認", head: "new", at: 9 }, { id: "b", claude: false, fam: "返信", head: "x", at: 2 }, { id: "b", claude: false, fam: "確認", head: "y", at: 7 },
]);
assert.deepEqual([ar.sameHead, ar.nearHead], [1, 1]);
assert.deepEqual(ar.rows.filter((r) => r.id === "a").map((r) => r.head), ["new", "new"], "一番新しい Claude の版と同じ版だけ");
assert.deepEqual(ar.rows.filter((r) => r.id === "b" && !r.claude).map((r) => r.head), ["y"], "同じ版が無ければ時刻の一番近い版");
console.log("claude-split-learned: ok 20");
