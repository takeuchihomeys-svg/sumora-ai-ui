// 2026-11-27 作業員L（統括役の決め）: 中心の材料の塊の印（記録だけ・既定 on）。プロンプトが1字も変わらない＝印はプロンプトを組んだ後・材料の目録の後に足し、material_marks にだけ入る
// 実行: npx tsx app/lib/__tests__/core-material-marks.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "../brain-core.ts"), "utf8");
const at = (needle: string) => { const i = src.indexOf(needle); assert.ok(i >= 0, `見つからない: ${needle}`); return i; };
const coreAt = at("const core: Record<string, string> = { core_sent_props: sentPropsText");
assert.ok(at("const customerSpecificTextFull = buildCustomerSpecific(new Set<string>());") < coreAt, "ブレインのプロンプトを組んだ後に足す");
assert.ok(at("{ split: [\"customerState\"], marks: materialMarks }") < coreAt, "材料の目録（指示書の入力）の後に足す＝目録も変わらない");
// 印の後で materialMarks を読むのは記録（meta.material_marks）だけ
// 昼の届きの確かめの1行（console に出すだけ・EXAM_MARKS_PREFLIGHT=on の時だけ）は読みに数えない
const after = src.slice(coreAt + 200).split(/\r?\n/).filter((l) => !l.includes('process.env.EXAM_MARKS_PREFLIGHT === "on"')).join("\n");
const uses = [...after.matchAll(/materialMarks(?!\.[a-z_]+\s*=)(?!\[)/g)].map((m) => after.slice(Math.max(0, m.index! - 40), m.index! + 60));
assert.ok(uses.length >= 1 && uses.every((u) => /material_marks:|materialMarks\)\.length|\.\.\.materialMarks/.test(u)), `印の後の materialMarks の読みは記録だけ: ${uses.join(" ／ ")}`);
assert.ok(/CORE_MATERIAL_MARKS \?\? ""\)\.trim\(\)\.toLowerCase\(\) !== "off"/.test(src), "既定 on・=off で止める");
for (const k of ["core_sent_props", "core_ledger", "core_aix_history", "core_estimate_records", "core_viewings", "core_promise", "core_cond"]) assert.ok(src.includes(`${k}: `), k);
console.log("core-material-marks ok 6");
