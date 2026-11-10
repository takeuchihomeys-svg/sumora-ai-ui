// 重なりの知らせ（scripts/lib/exam-overlap.ts）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-overlap.test.ts（全 PASS で exit 0）
import { findOverlaps, overlapBlocks, overlapLine, weakFor, jobProblemIds, type OverlapJob } from "../exam-overlap";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

// 11/10 の実物の形: 作業員4 の q118 の掘り（dig-q118-rfp）が待ちの時に、別の作業員が q118 を積む
const jobs: OverlapJob[] = [
  { label: "dig-q118-rfp", owner: "作業員4", switch: "BRAIN_RFP", only: "q118", state: "待ち" },
  { label: "cc-prime2", owner: "作業員9", switch: "", runner: "cmd", cmds: ["scripts/brain-exam.ts --label=cc-prime2 --only=q021,q118 --repeat=1"], state: "待ち" },
  { label: "night-base-2026-11-09", owner: "夜の基準", only: "", cmds: ["scripts/brain-exam.ts --only=q118"], state: "済み" },
  { label: "vector-1105-tscr47", owner: "作業員5", runner: "tsc-remote", only: "", state: "待ち" },
];
ok("cmd の --only も読む", jobProblemIds(jobs[1]).join(",") === "q021,q118");
const h = findOverlaps(["q118", "q200"], { label: "fc-ready-dig-1110", switch: "BRAIN_FC" }, jobs);
ok("重なり: 待ちの2本（夜の基準・tsc は数えない）", h.length === 2 && h.every((x) => x.id === "q118"), JSON.stringify(h));
ok("違うスイッチは止めない", overlapBlocks(h).length === 0);
const h2 = findOverlaps(["q118"], { label: "rfp-on-2", switch: "BRAIN_RFP" }, jobs);
ok("同じスイッチ・同じ問題は止める", overlapBlocks(h2).length === 1 && overlapBlocks(h2)[0].label === "dig-q118-rfp");
ok("自分の label は数えない", findOverlaps(["q118"], { label: "dig-q118-rfp", switch: "BRAIN_RFP" }, jobs).every((x) => x.label !== "dig-q118-rfp"));
ok("スイッチが空同士は同じスイッチにしない", findOverlaps(["q118"], { label: "x", switch: "" }, jobs).every((x) => !x.sameSwitch));

const weak = weakFor(["q118", "q11"], [
  { id: 383, status: "in_progress", root_cause: "未調べ（作業員4が掘る）", evidence: { problems: ["q118"] } },
  { id: 400, status: "fixed", root_cause: "直した", symptom: "q11 の外れ" },
  { id: 401, status: "open", root_cause: "材料の欄が入口に届いていない", symptom: "q011 と q118 の外れ" },
]);
ok("弱い所: q118 は最初の行（語の切れ目・fixed は除く）", weak.get("q118")?.id === 383 && !weak.has("q11"), JSON.stringify([...weak]));
const line = overlapLine(h, weak);
ok("1行: 作業員と状態と弱い所", line.startsWith("重なり: q118（作業員4 dig-q118-rfp・待ち／作業員9 cc-prime2・待ち）") && line.includes("弱い所 383") && line.includes("原因は未調べ"), line);
const w2 = weakFor(["q118"], [{ id: 401, status: "open", root_cause: "材料の欄が入口に届いていない", symptom: "q118" }]);
ok("原因が書いてあれば「原因は分かっている」", overlapLine([], w2).includes("原因は分かっている（弱い所 401: 材料の欄"), overlapLine([], w2));
ok("重なりも弱い所も無ければ空", overlapLine([], new Map()) === "");

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
