// DELIVERY_CHECK の既定（app/lib/delivery-check.ts・2026-11-23 既定 shadow＝記録だけ）
// 実行: npx tsx app/lib/__tests__/delivery-check-default.test.ts（全 PASS で exit 0）
import { deliveryCheckMode, deliveryCheckOf } from "../delivery-check";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };

ok("既定は shadow（記録だけ）", deliveryCheckMode({}) === "shadow");
ok("止める DELIVERY_CHECK=off", deliveryCheckMode({ DELIVERY_CHECK: "off" }) === "off" && deliveryCheckMode({ DELIVERY_CHECK: " OFF " }) === "off");
ok("shadow・on は shadow", deliveryCheckMode({ DELIVERY_CHECK: "shadow" }) === "shadow" && deliveryCheckMode({ DELIVERY_CHECK: "on" }) === "shadow");
// 道は変えない: 届いたかの確かめは meta を読むだけ（道の欄 reply_mode・action・turn_contract を書き換えない）
const meta: Record<string, unknown> = { reply_mode: "aix", action: "property_send", turn_contract: { asks: [{ q: "x", route: "aix" }] }, conductor_brief: { main: "物件" } };
const before = JSON.stringify(meta);
const r = deliveryCheckOf(meta);
ok("確かめは meta を書き換えない（道は変わらない）", JSON.stringify(meta) === before && typeof r === "object" && r !== null);

console.log(`delivery-check-default: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
