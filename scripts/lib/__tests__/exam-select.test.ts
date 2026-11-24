// 2026-11-24 夜 作業員A（台帳 #683 の広げ）: 回す問題の最小の組（scripts/lib/exam-select.ts）
// 実行: npx tsx scripts/lib/__tests__/exam-select.test.ts（env 不要・全 OK で exit 0）
import { selectMinimal, sameConclusion } from "../exam-select";

let passed = 0, failed = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log("  OK  " + name); } else { failed++; console.log("  NG  " + name + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : "")); }
}
const table = { SW: { needs: ["line_tasks"] }, ALL: { needs: ["x"], promptAll: true } };
const prior = new Map([["q1", { line_tasks: 2 }], ["q2", { line_tasks: 0 }], ["q3", {}], ["q4", {}], ["q5", {}]]);
const off = new Map([["q2", { pass: 0, n: 3 }], ["q3", { pass: 3, n: 3 }], ["q4", { pass: 4, n: 4 }], ["q5", { pass: 2, n: 3 }]]);
const s = selectMinimal({ ids: ["q1", "q2", "q3", "q4", "q5", "q6"], onSwitches: ["SW"], prior, off, table, stage: "brain" });
const why = Object.fromEntries(s.keep.map((k) => [k.id, k.why]));
t("材料ありは残す（効く欄つき）", why.q1 === "材料あり" && s.keep.find((k) => k.id === "q1")?.note === "line_tasks");
t("材料0でも今の off で外れは残す（余地）", why.q2 === "今の off で外れ（余地）");
t("前の回が無い問題は残す（材料が分からない）", why.q6 === "前の回が無い（材料が分からない）");
t("守りは off で安定して合格の問題から1問（id 順）", why.q3 === "守り（off で安定して合格）" && !why.q4);
t("選ばなかった問題の理由を数える（守りの2問目）・揺れは落とさない", s.dropCounts["材料0・off で合格（守りは1問で足りる）"] === 1 && why.q5 === "off で揺れ（落とさない）", s.dropCounts);
t("費用: 全部と選んだ組", s.usdAll === 0.96 && s.usdKeep === 0.8 && s.narrowed);
const w = selectMinimal({ ids: ["q3", "q4"], onSwitches: ["SW"], prior, off, table, stage: "brain", weightOf: (id) => (id === "q4" ? 0.5 : 0.1) });
t("守りは型の重みの高い方を先に", w.keep.some((k) => k.id === "q4") && !w.keep.some((k) => k.id === "q3"));
const u = selectMinimal({ ids: ["q1", "q3"], onSwitches: ["NOPE"], prior, off, table, stage: "brain" });
t("効く欄が表に無いスイッチは絞らない（全部を回す）", !u.narrowed && u.keep.length === 2);
const pa = selectMinimal({ ids: ["q1", "q3"], onSwitches: ["ALL"], prior, off, table, stage: "brain" });
t("指示文が全問に入るスイッチも絞らない", !pa.narrowed);
t("同じ結論: 悪化・改善の問題が選んだ組に全部入る", sameConclusion(s, { worse: ["q1"], better: ["q2"] }).same && !sameConclusion(s, { worse: ["q4"], better: [] }).same && sameConclusion(s, { worse: ["q4"], better: [] }).missedWorse[0] === "q4");
console.log(`\n${passed} OK / ${failed} NG`);
process.exit(failed ? 1 : 0);
