// 2026-11-10 作業員8（D1）: 回数だけ違う構成の置き場の答えを使う決め
// 実行: npx tsx scripts/lib/__tests__/brain-exam-baseline-subset.test.ts（env 不要・全 OK で exit 0）
import { repeatSubsetCompatible, trimRowsToRepeat, findCarryOver, type ExamConfig, type BaselineFile } from "../brain-exam-baseline";

let passed = 0, failed = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log("  OK  " + name); } else { failed++; console.log("  NG  " + name + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : "")); }
}
// 11/10 の版 7b1474e7dcdc の実際の構成（8381e072a8＝repeat 4・e95b712aa6＝repeat 1・6288b358ad＝repeat 3＋judgeLazy・a8d2fed623＝下書きの段）
const env = { LLM_ALT_ACTIONS: "reply_generate", LLM_ALT_PROVIDER: "deepseek", LLM_TEST_MODE: "deepseek-all" };
const base = { autoHint: false, clock: "frozen", dbSnap: "day", draftFirstOnly: false, exhaustedRule: null, judgeRepeat: 1, layer: "prod", ledger: true, noJudge: false, sceneTimes: "gaps-day", stage: "brain", stageByType: null };
const r4: ExamConfig = { args: { ...base, repeat: 4, repeatFlaky: true }, env };
const r1: ExamConfig = { args: { ...base, repeat: 1 }, env };
const r3lazy: ExamConfig = { args: { ...base, judgeLazy: true, repeat: 3, repeatFlaky: true }, env };
const r4draft: ExamConfig = { args: { ...base, repeat: 4, repeatFlaky: true, stage: "draft" }, env };

t("repeat=1 は repeat=4 の置き場を使える（e95b712aa6 ← 8381e072a8）", repeatSubsetCompatible(r1, r4));
t("repeat=4 は repeat=1 の置き場を使えない（回が足りない）", !repeatSubsetCompatible(r4, r1));
t("判定の口（judgeLazy）が違えば使わない", !repeatSubsetCompatible(r3lazy, r4));
t("段（brain と draft）が違えば使わない", !repeatSubsetCompatible({ ...r1 }, r4draft));
t("スイッチ（env）が違えば使わない", !repeatSubsetCompatible(r1, { ...r4, env: { ...env, X_SWITCH: "on" } }));
t("args の並びの順は見ない", repeatSubsetCompatible({ args: Object.fromEntries(Object.entries(r1.args).reverse()), env }, r4));

const rows = [1, 2, 3, 4].map((rep) => ({ rep }));
t("回 1..repeat の行だけ残す", JSON.stringify(trimRowsToRepeat(rows, 1)) === JSON.stringify([{ rep: 1 }]) && trimRowsToRepeat(rows, 3).length === 3);

const b: BaselineFile<{ rep: number; error?: string }> & { dir?: string } = { id: "q010", problemHash: "h1", commit: "c", config: r4, savedAt: "2026-11-10T13:16:11Z", fromLabel: "x", rows: trimRowsToRepeat(rows, 1), dir: "v-7b1474e7dcdc-8381e072a8" };
const hit = findCarryOver([b], { hash: "h1" }, { key: "vk", keyOf: () => "vk", envFp: "" }, 1, { now: Date.parse("2026-11-11T00:00:00Z"), maxAgeMs: 7 * 86_400_000 });
t("配線: 部分集合にした行で findCarryOver が当たる（repeat=1）", !!hit && hit.rows.length === 1);
const miss = findCarryOver([{ ...b, problemHash: "other" }], { hash: "h1" }, { key: "vk", keyOf: () => "vk", envFp: "" }, 1, {});
t("配線: 問題が変われば当たらない", miss === null);

console.log(`\n${passed} OK / ${failed} NG`);
process.exit(failed ? 1 : 0);
