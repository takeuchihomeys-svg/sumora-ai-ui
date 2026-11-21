// npx tsx app/lib/__tests__/check-name-fill.test.ts
// 2026-11-21 作業員K2: 物件名が空の物件確認した を、お客様の持ち込みが1件に決まる時だけ埋める（CHECK_NAME_FILL・既定 off）
import assert from "node:assert/strict";
import { checkNameFillOn, resolveCheckPropertyName, candsFromImageRecords, filledLabel } from "../check-name-fill";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
t("既定 off", () => { assert.equal(checkNameFillOn({}), false); assert.equal(checkNameFillOn({ CHECK_NAME_FILL: "on" }), true); });
t("1件に決まる（表記ゆれは同じ建物・号室は付いている方）", () => {
  const r = resolveCheckPropertyName([{ name: "物件Ａ 本町", via: "customer_sent:image" }, { name: "物件A本町", room: "301", via: "image_record:portal_title" }]);
  assert.deepEqual(r && { name: r.name, room: r.room }, { name: "物件A本町", room: "301" });
  assert.equal(filledLabel(r!), "物件A本町 301");
});
t("建物が2つ・同じ建物で号室が2つ・名前なし → 埋めない", () => {
  assert.equal(resolveCheckPropertyName([{ name: "物件A", via: "x" }, { name: "物件B", via: "x" }]), null);
  assert.equal(resolveCheckPropertyName([{ name: "物件A", room: "301", via: "x" }, { name: "物件A", room: "302", via: "x" }]), null);
  assert.equal(resolveCheckPropertyName([{ name: null, via: "x" }]), null);
  assert.equal(resolveCheckPropertyName([]), null);
});
t("customer_image_records は G の線だけ（確かさ・種類・こちらが送った物は外す）", () => {
  const rows = [
    { property_name: "物件A", room_no: "", certainty: "high", kind: "property_screen", ours_kind: null, name_via: "portal_title" },
    { property_name: "物件B", room_no: "101", certainty: "low", kind: "property_screen", ours_kind: null, name_via: "text" },
    { property_name: "物件C", room_no: "101", certainty: "high", kind: "property_material", ours_kind: "same_room", name_via: "text" },
    { property_name: "物件D", room_no: "101", certainty: "mid", kind: "document", ours_kind: null, name_via: "text" },
  ];
  const c = candsFromImageRecords(rows);
  assert.equal(c.length, 1); assert.equal(c[0].name, "物件A"); assert.equal(c[0].room, null);
});
console.log(`${n} ok`);
