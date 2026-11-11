// 自己申告の鍵の印を digest に残す（記録だけ・BRAIN_MATERIAL_SIDE_SHADOW・2026-11-11 作業員1 A1 ③）
// 名前は実物（brain_unknowns の material_missing の label）
// 実行: npx tsx app/lib/__tests__/material-side-shadow.test.ts
import { brainDecisionDigestExtra, materialSideShadowOn } from "../brain-decision-ledger";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) pass++; else { fail++; console.log(`  NG  ${name}`, extra); } };
const on = { BRAIN_MATERIAL_SIDE_SHADOW: "on" };

t("既定 on（11/11）・=off で止まる", materialSideShadowOn({}) && !materialSideShadowOn({ BRAIN_MATERIAL_SIDE_SHADOW: "off" }));
const off = brainDecisionDigestExtra({ material_missing: ["シェモワアサヒの募集状況", "送れる物件の候補"] }, { BRAIN_MATERIAL_SIDE_SHADOW: "off" }) as Record<string, unknown>;
t("off: mm だけ（mk・mks は付けない）", Array.isArray(off.mm) && off.mk === undefined && off.mks === undefined, off);
const a = brainDecisionDigestExtra({ material_missing: ["シェモワアサヒの募集状況", "送れる物件の候補", "見積の金額"] }, on) as Record<string, unknown>;
t("on: 鍵の一覧（重なりなし）と staff の印", JSON.stringify(a.mk) === JSON.stringify(["vacancy_status", "sendable_candidates", "estimate_amount"]) && a.mks === true, a);
const b = brainDecisionDigestExtra({ material_missing: ["送れる物件の候補", "エリア希望"] }, on) as Record<string, unknown>;
t("on: staff の鍵が無ければ mks なし", JSON.stringify(b.mk) === JSON.stringify(["sendable_candidates", "customer_conditions"]) && b.mks === undefined, b);
const c = brainDecisionDigestExtra({ material_missing: [] }, on) as Record<string, unknown>;
t("on: 申告が空（足りていた）は mk なし", Array.isArray(c.mm) && c.mk === undefined, c);
// 2026-11-11 作業員14 の指摘: 気持ちの ms（toFreshDigest）を材料の鍵で上書きしない（digest は {...fresh, ...extra} の順で作る）
const merged = { ms: "安くしたい||費用で迷う|家賃:c", ...brainDecisionDigestExtra({ material_missing: ["シェモワアサヒの募集状況"] }, on) } as Record<string, unknown>;
t("気持ちの ms が残る（材料の鍵は mk）", merged.ms === "安くしたい||費用で迷う|家賃:c" && JSON.stringify(merged.mk) === JSON.stringify(["vacancy_status"]) && merged.mks === true, merged);
const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "brain-decision-ledger.ts"), "utf8");
t("台帳の関数は ms・mss を書かない", !src.includes(").ms = keys") && !src.includes(").mss = true"));
console.log(`material-side-shadow: ${pass}/${pass + fail}`); if (fail) process.exit(1);
