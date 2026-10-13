// app/lib/__tests__/override-demote.test.ts — 2026-10-13 決定論の上書きを材料＋食い違いのログに下げる
//   実行: npx tsx app/lib/__tests__/override-demote.test.ts
import { overrideDemoted, applyOverride, compactDemoted, DEMOTE_ENV, type DemotedOverride } from "../override-demote";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

t("既定は下げる（signal）", overrideDemoted("signal", {}));
t("BRAIN_DEMOTE_SIGNAL=off で旧の上書き", !overrideDemoted("signal", { BRAIN_DEMOTE_SIGNAL: "off" }));
t("家族ごとに別の環境変数", new Set(Object.values(DEMOTE_ENV)).size === Object.keys(DEMOTE_ENV).length);

// 本番の形: ブレインは AIX なし・信号は 物件ピックアップ（signal:property_send 0/20）
const list: DemotedOverride[] = [];
t("下げている時は上書きしない（false）", applyOverride(list, "signal", "signal:property_send", "property_send", null, {}) === false);
t("食い違いを残す", list.length === 1 && list[0].would === "property_send" && list[0].brain === null);
t("同じ src は1回", (applyOverride(list, "signal", "signal:property_send", "property_send", null, {}), list.length === 1));
t("ブレインと同じ答えは食い違いにしない", (applyOverride(list, "signal", "signal:scene_S10_phone_request", "phone_call", "phone_call", {}), list.length === 1));
t("戻した時は上書きする（true）・記録しない", applyOverride(list, "signal", "signal:scene_S8_cost_doubt", "cost_explain", null, { BRAIN_DEMOTE_SIGNAL: "off" }) === true && list.length === 1);
t("meta の形", JSON.stringify(compactDemoted(list)) === JSON.stringify([{ f: "signal", src: "signal:property_send", would: "property_send", brain: null }]));
t("空なら undefined", compactDemoted([]) === undefined);

console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
