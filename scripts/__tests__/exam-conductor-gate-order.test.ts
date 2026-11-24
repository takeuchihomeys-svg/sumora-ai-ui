// 2026-11-24 夜 作業員A（統括役の頼み）: exam-conductor --add の積む前の関所の順が壊れていないか（材料0 → 問題の絞り → 使い方の表の版 → 値打ち → 守りの自動足し）
//   値打ちは、材料0 の問題を外し・絞った後の問題で見る（外す前に見ると、外れる問題の余地で積んでしまう）。表の版の関所は値打ちより前（OpenAI の依頼で表が無ければ先に止める）
// 実行: npx tsx scripts/__tests__/exam-conductor-gate-order.test.ts（env 不要・全 OK で exit 0）
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0, failed = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log("  OK  " + name); } else { failed++; console.log("  NG  " + name + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : "")); }
}
const src = readFileSync(join(__dirname, "..", "exam-conductor.ts"), "utf8");
const at = (needle: string) => src.indexOf(needle);
const order = [
  ["材料0の関所", "const gate = preflightGate(pr, ids, preflightGateMode());"],
  ["問題の絞り", "const nr = narrowProblems({"],
  ["使い方の表の版", 'const pf = join(cwd, "app", "lib", "provider-profile.ts");'],
  ["値打ちの関所", "const wg = worthGate(eff, loadOffPass("],
  ["回す問題の最小の組（#683）", "const sel = selectMinimal({ ids, onSwitches: onSel"],
  ["守りの自動足し", "if (job.runner === \"brain-exam\" && ids.length && !job.dig && autoGuards && !focusPicked) {"],
] as const;
const pos = order.map(([name, n]) => ({ name, i: at(n) }));
t("関所が全部ある", pos.every((p) => p.i >= 0), pos.filter((p) => p.i < 0).map((p) => p.name));
t("順: 材料0 → 絞り → 表の版 → 値打ち → 最小の組 → 守りの自動足し", pos.every((p, k) => k === 0 || p.i > pos[k - 1].i), pos);
t("値打ちの関所は --force で越え・EXAM_WORTH_GATE=off で止まる", /EXAM_WORTH_GATE \?\? ""\)\.trim\(\)\.toLowerCase\(\) !== "off"/.test(src) && /wg\.block && !flag\("force"\)/.test(src));
t("衝突の印が残っていない", !/^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(src));
console.log(`\n${passed} OK / ${failed} NG`);
process.exit(failed ? 1 : 0);
