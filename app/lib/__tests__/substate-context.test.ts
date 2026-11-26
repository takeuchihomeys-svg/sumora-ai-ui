// app/lib/__tests__/substate-context.test.ts — 細かい状態の前提（2026-11-27 作業員A・SUBSTATE_CONTEXT 既定 off）
//   実行: npx tsx app/lib/__tests__/substate-context.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { substateInContext, substateContextOn, SUBSTATE_NEEDS } from "../substate-context";
import { matchSubstateOf } from "../turn-aims-after";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const on = { SUBSTATE_CONTEXT: "on" };
const budget = "予算オーバーで高いです";
const s0 = matchSubstateOf(budget, {});
t("網の言葉は今のまま（off は同じ答え）", substateInContext(budget, { estimateSent: false, propertiesSent: false }, {}).id === (s0?.id ?? null));
if (s0 && SUBSTATE_NEEDS[s0.id]?.includes("estimateSent")) t("見積を送る前の「高い」は見積の駅の状態にしない（on）", substateInContext(budget, { estimateSent: false, propertiesSent: true }, on).droppedBy === "estimateSent" && substateInContext(budget, { estimateSent: true, propertiesSent: true }, on).id === s0.id);
t("前提の表: 見積の状態は見積・提案中の状態は物件を送った", SUBSTATE_NEEDS.cost_over_budget.includes("estimateSent") && SUBSTATE_NEEDS.proposing_liked_one.includes("propertiesSent") && !SUBSTATE_NEEDS.brought_vacancy);
t("既定 off", !substateContextOn({}) && substateContextOn(on));
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: on の時だけ前提つき・落とした番の印 substate_context_dropped", bc.includes("substateContextOn() ? substateInContext(") && bc.includes("materialMarks.substate_context_dropped = 1"));
console.log(`substate-context: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
