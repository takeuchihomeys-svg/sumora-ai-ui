// scripts/lib/__tests__/route-progress-same-step.test.ts — 地図の候補と竹内さんの一手の一致の、同じ一手の仲間の AIX（2026-11-25 作業員A・#687）
//   実行: npx tsx scripts/lib/__tests__/route-progress-same-step.test.ts
import { routeAgreement, sameStepAix } from "../route-progress";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const loc = (aix: string[], branch: string | null = null) => ({ next: { label: "x", aix }, branch }) as never;
t("物件の束⇄1件は同じ一手", routeAgreement(loc(["property_send"]), "aix:property_recommendation") === "aix_match");
t("持ち込みの駅の見積書送るは確認の結果を送った一手", routeAgreement(loc(["property_check_result"], "brought_property"), "aix:estimate_sheet") === "aix_match");
t("持ち込みでない駅の見積書送るは違う AIX のまま", routeAgreement(loc(["property_check_result"]), "aix:estimate_sheet") === "other_aix");
t("持ち込みの駅でも物件の束は違う AIX のまま", routeAgreement(loc(["property_check_result"], "brought_property"), "aix:property_send") === "other_aix");
t("ROUTE_AGREE_STRICT=on で前の数え方", !sameStepAix(["property_send"], "property_recommendation", null, { ROUTE_AGREE_STRICT: "on" }));
console.log(`route-progress-same-step: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
