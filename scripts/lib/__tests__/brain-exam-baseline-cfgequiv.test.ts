// 2026-11-24 作業員A（統括役の頼み c・off の基準の使い回し）: 既定と同じ値の env が片方に無いだけの構成を同じとみる決め（configEquivalent）
// 実行: npx tsx scripts/lib/__tests__/brain-exam-baseline-cfgequiv.test.ts（env 不要・全 OK で exit 0）
import { configEquivalent, oneSidedEnvKeys, type ExamConfig } from "../brain-exam-baseline";

let passed = 0, failed = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log("  OK  " + name); } else { failed++; console.log("  NG  " + name + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : "")); }
}
const args = { clock: "frozen", dbSnap: "day", layer: "prod", stage: "brain", repeat: 2 };
const defs = new Map([["AIX_BROUGHT_MATERIAL", "on"], ["BRAIN_MESSAGE_PLAN", "off"], ["AIX_BROUGHT_MAX_AGE_DAYS", "14"]]);
const want: ExamConfig = { args, env: { LLM_TEST_MODE: "deepseek-all" } };
// 11/24 の実例: 係の設定（examEnv）が乗った回は既定と同じ値が書いてある
const have: ExamConfig = { args: { ...args, repeat: 4 }, env: { LLM_TEST_MODE: "deepseek-all", AIX_BROUGHT_MATERIAL: "on", BRAIN_MESSAGE_PLAN: "off", AIX_BROUGHT_MAX_AGE_DAYS: "14" } };
t("既定と同じ値が片方にだけある＋相手の回数が多い＝同じ", configEquivalent(want, have, defs));
t("片方にだけある名前を出す", oneSidedEnvKeys(want, have).sort().join(",") === "AIX_BROUGHT_MATERIAL,AIX_BROUGHT_MAX_AGE_DAYS,BRAIN_MESSAGE_PLAN");
t("既定と違う値（on にした）＝違う", !configEquivalent(want, { ...have, env: { ...have.env, BRAIN_MESSAGE_PLAN: "on" } }, defs));
t("既定が読めない名前＝違う（推して同じにしない）", !configEquivalent(want, { ...have, env: { ...have.env, NEW_SWITCH_X: "on" } }, defs));
t("相手の回数が少ない＝違う", !configEquivalent({ ...want, args: { ...args, repeat: 4 } }, { ...have, args: { ...args, repeat: 2 } }, defs));
t("回数以外の args が違う（段）＝違う", !configEquivalent(want, { ...have, args: { ...have.args, stage: "draft" } }, defs));
t("両方にある値は大文字小文字・空白をそろえて比べる", configEquivalent({ args, env: { X: "On " } }, { args, env: { X: "on" } }, new Map()));
console.log(`\n${passed} OK / ${failed} NG`);
process.exit(failed ? 1 : 0);
