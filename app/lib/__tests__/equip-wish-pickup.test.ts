// npx tsx app/lib/__tests__/equip-wish-pickup.test.ts
// 2026-11-21 作業員K2: 設備の希望を次のピックアップの文の軸に（EQUIP_WISH_PICKUP・既定 off）
import assert from "node:assert/strict";
import { equipWishPickupOn, latestEquipWishTopics, equipWishPickupNote } from "../equip-wish-pickup";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
t("既定 off", () => { assert.equal(equipWishPickupOn({}), false); assert.equal(equipWishPickupOn({ EQUIP_WISH_PICKUP: "on" }), true); });
t("q439 型の希望（カウンターキッチンがいい）を拾う", () => {
  const k = latestEquipWishTopics(["ありがとうございます", "できればカウンターキッチンのお部屋がいいです"]);
  assert.ok(k.includes("counter_kitchen"), JSON.stringify(k));
  const note = equipWishPickupNote(k);
  assert.ok(note.includes("カウンターキッチン付きのお部屋でピックアップ") && note.includes("付いていると書かない"));
});
t("「が良いです」も拾う・質問は拾わない", () => { assert.deepEqual(latestEquipWishTopics(["独立洗面台が良いです"]), ["washbasin"]); assert.deepEqual(latestEquipWishTopics(["カウンターキッチンはありますか？"]), []); });
t("希望の無い発言は空", () => { assert.deepEqual(latestEquipWishTopics(["ありがとうございます", "よろしくお願いします"]), []); assert.equal(equipWishPickupNote([]), ""); });
console.log(`${n} ok`);
