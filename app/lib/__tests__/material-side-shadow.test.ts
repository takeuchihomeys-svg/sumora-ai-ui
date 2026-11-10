// 自己申告の鍵の印を digest に残す（記録だけ・BRAIN_MATERIAL_SIDE_SHADOW・2026-11-11 作業員1 A1 ③）
// 名前は実物（brain_unknowns の material_missing の label）
// 実行: npx tsx app/lib/__tests__/material-side-shadow.test.ts
import { brainDecisionDigestExtra, materialSideShadowOn } from "../brain-decision-ledger";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) pass++; else { fail++; console.log(`  NG  ${name}`, extra); } };
const on = { BRAIN_MATERIAL_SIDE_SHADOW: "on" };

t("既定 off", !materialSideShadowOn({}) && materialSideShadowOn(on));
const off = brainDecisionDigestExtra({ material_missing: ["シェモワアサヒの募集状況", "送れる物件の候補"] }, {}) as Record<string, unknown>;
t("off: mm だけ（ms・mss は付けない）", Array.isArray(off.mm) && off.ms === undefined && off.mss === undefined, off);
const a = brainDecisionDigestExtra({ material_missing: ["シェモワアサヒの募集状況", "送れる物件の候補", "見積の金額"] }, on) as Record<string, unknown>;
t("on: 鍵の一覧（重なりなし）と staff の印", JSON.stringify(a.ms) === JSON.stringify(["vacancy_status", "sendable_candidates", "estimate_amount"]) && a.mss === true, a);
const b = brainDecisionDigestExtra({ material_missing: ["送れる物件の候補", "エリア希望"] }, on) as Record<string, unknown>;
t("on: staff の鍵が無ければ mss なし", JSON.stringify(b.ms) === JSON.stringify(["sendable_candidates", "customer_conditions"]) && b.mss === undefined, b);
const c = brainDecisionDigestExtra({ material_missing: [] }, on) as Record<string, unknown>;
t("on: 申告が空（足りていた）は ms なし", Array.isArray(c.mm) && c.ms === undefined, c);
console.log(`material-side-shadow: ${pass}/${pass + fail}`); if (fail) process.exit(1);
