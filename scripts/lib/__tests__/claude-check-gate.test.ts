// scripts/lib/__tests__/claude-check-gate.test.ts — 本番と割れやすい場面の直しの Claude の確かめの関所（2026-11-25 作業員A）
//   実行: npx tsx scripts/lib/__tests__/claude-check-gate.test.ts
import { familyOfAnswer, scenesOfProblem, claudeCheckTargets, claudeGateVerdict, claudeCheckGateMode, claudeCheckLabel } from "../claude-check-gate";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("系統: AIX・2段・返信", familyOfAnswer("AIX:property_check_result") === "確認" && familyOfAnswer("2段:check") === "確認" && familyOfAnswer("2段:pickup") === "物件" && familyOfAnswer("返信") === "返信" && familyOfAnswer("AIX:物件") === "物件");
t("型: 正解が返信でも外れに物件確認した があれば当たる", scenesOfProblem({ id: "a", accept: ["返信"], mustNot: ["AIX:property_check_result"] }).length === 1);
t("型: 内覧だけの問題は当たらない", scenesOfProblem({ id: "b", accept: ["AIX:viewing_invite"], mustNot: ["返信"] }).length === 0);
t("型: 本番の道が物件の AIX なら当たる", scenesOfProblem({ id: "c", accept: ["返信"], prodBrain: { mode: "aix", action: "property_send" } }).length === 1);
const probs = new Map([["q1", { id: "q1", accept: ["AIX:property_check_result"] }], ["q2", { id: "q2", accept: ["AIX:meeting_place"] }]]);
const tg = claudeCheckTargets(["q1", "q2", "q9"], probs);
t("効く問題から型の合う物だけ", tg.length === 1 && tg[0].id === "q1");
t("関所: warn は止めない・on は記録が無ければ止める・記録があれば通す", !claudeGateVerdict({ mode: "warn", targets: tg, record: null }).block && claudeGateVerdict({ mode: "on", targets: tg, record: null }).block
  && !claudeGateVerdict({ mode: "on", targets: tg, record: { label: "cc-x", ids: ["q1"], pass: 1, n: 1 } }).block && claudeGateVerdict({ mode: "on", targets: [], record: null }).line === "");
t("既定は warn", claudeCheckGateMode({}) === "warn" && claudeCheckGateMode({ CLAUDE_CHECK_GATE: "on" }) === "on");
t("組の名前", claudeCheckLabel("BRAIN_CHECK_PROMISE_FLOW", "2026-11-25") === "cc-brain-check-promise-flow-2026-11-25");
console.log(`claude-check-gate: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
