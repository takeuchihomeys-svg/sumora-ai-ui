// 2026-10-06 v2.5.78（⑯）1人のお客様の2つ目の探し物（子の行）を親と一緒に扱う決まり
// 実行: npx tsx app/lib/__tests__/customer-family.test.ts（自己完結・env 不要）
import { familyIds } from "../customer-family";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0, failed = 0;
const t = (name: string, cond: boolean, extra?: unknown) => { if (cond) { passed++; console.log("  OK  " + name); } else { failed++; console.log("  NG  " + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); } };

console.log("── 送付済みを見る id");
t("子（ゆいと（物置））は子＋親", JSON.stringify(familyIds({ id: "887420dc", parent_customer_id: "23f2f823" })) === JSON.stringify(["887420dc", "23f2f823"]));
t("親・ふつうのお客様は自分だけ", JSON.stringify(familyIds({ id: "23f2f823", parent_customer_id: null })) === JSON.stringify(["23f2f823"]));
t("自分を親にしている壊れた行は自分だけ", familyIds({ id: "a", parent_customer_id: "a" }).length === 1);
t("行が無い時は空", familyIds(null).length === 0);

console.log("── 使う所（送付済みの3か所が同じ決まり）");
const root = join(__dirname, "..", "..", "..");
const rd = (p: string) => readFileSync(join(root, p), "utf8");
t("sent-rooms（案内・一括の送付済み）は子＋親", /const ids = await familyIdsFor\(sb, customerId\);/.test(rd("app/lib/sent-rooms-server.ts")) && /\.in\("property_customer_id", ids\.length \? ids : \[customerId\]\)/.test(rd("app/lib/sent-rooms-server.ts")));
t("sent-check（送付済みの建物の印）は子＋親", /familyIdsFor\(sb, customerId\)/.test(rd("app/api/automation/sent-check/route.ts")));
const mp = rd("app/api/merge-pdfs/route.ts");
t("merge-pdfs の除外（送付済みは送らない）も子＋親", /q\.in\("property_customer_id", sentScopeIds\.length \? sentScopeIds : \[resolvedCustomerId\]\)/.test(mp) && /dupQuery\.in\("property_customer_id", sentScopeIds\.length \? sentScopeIds : \[propertyCustomerId\]\)/.test(mp));
t("merge-pdfs: 子の売上サポ・送付の記録は親の会話に結ぶ（拡張が渡さない時も補う）・お客様の id は子のまま", /const convIdEff: string \| null = conversation_id \?\? \(resolvedCustomerId \? await parentConversationFor/.test(mp) && /propertyCustomerId: resolvedCustomerId, conversationId: convIdEff,/.test(mp) && /conversation_id: convIdEff,/.test(mp));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
