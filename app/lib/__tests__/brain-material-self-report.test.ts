// app/lib/__tests__/brain-material-self-report.test.ts — 材料の自己申告（2026-10-29・記録だけ）
//   実行: npx tsx app/lib/__tests__/brain-material-self-report.test.ts
import { brainMaterialSelfReportOn, normalizeMaterialMissing, MATERIAL_SELF_REPORT_INSTRUCTION } from "../brain-material-self-report";
import { brainDecisionDigestExtra } from "../brain-decision-ledger";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, v?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, JSON.stringify(v)); } };
t("既定は on", brainMaterialSelfReportOn({}));
t("off で止まる", !brainMaterialSelfReportOn({ BRAIN_MATERIAL_SELF_REPORT: "off" }));
t("指示に項目名", MATERIAL_SELF_REPORT_INSTRUCTION.includes("material_missing"));
t("項目が無い時は null（記録しない）", normalizeMaterialMissing(undefined) === null);
t("空の配列は [] で残す", JSON.stringify(normalizeMaterialMissing([])) === "[]");
t("なし・重複・空白を外す", JSON.stringify(normalizeMaterialMissing([" 入居時期 ", "入居時期", "なし", "", 3, "見積の金額"])) === '["入居時期","見積の金額"]', normalizeMaterialMissing([" 入居時期 ", "入居時期", "なし", "", 3, "見積の金額"]));
t("最大5つ", normalizeMaterialMissing(["a", "b", "c", "d", "e", "f"])!.length === 5);
t("文字列1つも配列に", JSON.stringify(normalizeMaterialMissing("送った物件の現況")) === '["送った物件の現況"]');
t("30字まで", normalizeMaterialMissing(["あ".repeat(40)])![0].length === 30);
const d = brainDecisionDigestExtra({ material_missing: ["入居時期"], material_read_misses: ["sent_props"] });
t("digest に mm と mx", JSON.stringify(d.mm) === '["入居時期"]' && JSON.stringify(d.mx) === '["sent_props"]', d);
const d0 = brainDecisionDigestExtra({ material_missing: [] });
t("[] も mm に残す・読めない物が無い時は mx なし", JSON.stringify(d0.mm) === "[]" && d0.mx === undefined, d0);
t("申告が無い時は mm なし", brainDecisionDigestExtra({}).mm === undefined);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
