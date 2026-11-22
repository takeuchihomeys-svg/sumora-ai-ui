// npx tsx app/lib/__tests__/image-read-rooms.test.ts
// 2026-11-19 作業員L: 部屋ごとの帖数（IMAGE_READ_ROOMS・既定 off）の読み・型・保存・ブレインへの1行
//   毎朝の穴の割り当て 11/19「402号室のリビングは何帖か」に資料から答えられなかった（読みの欄に帖数が無かった）の土台
import assert from "node:assert/strict";
import { PROPERTY_IMAGE_PROMPT, propertyImagePrompt, imageReadRoomsOn, parseReadResult, roomsOf } from "../property-image-read";
import { factsFromImageRead } from "../candidate-facts";
import { sentImageFactsLine } from "../sent-props-text";

// image-read-ledger は DB の口を読み込むので、試験の時だけ空の宛先を入れてから読む（DB には繋がない）
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test";

async function main() {
const { LEDGER_ITEMS_SYSTEM, ledgerItemsSystem } = await import("../image-read-ledger");

// 既定 off: 指示の文は今と1文字も変わらない（キャッシュも今のまま）
assert.equal(imageReadRoomsOn({}), false);
assert.equal(propertyImagePrompt({ IMAGE_READ_STATUS_STRICT: "off" }), PROPERTY_IMAGE_PROMPT); // 11/21 現況の指示（既定 on）を外すと元の指示
assert.equal(ledgerItemsSystem({ IMAGE_READ_STATUS_STRICT: "off" }), LEDGER_ITEMS_SYSTEM);

// on: 画像の読みと書き写しの読みの両方に rooms の1行が is_property の前に入る
for (const p of [propertyImagePrompt({ IMAGE_READ_ROOMS: "on" }), ledgerItemsSystem({ IMAGE_READ_ROOMS: "on" })]) {
  assert.ok(p.includes("- rooms: 間取り図に書かれた部屋ごとの帖数"));
  assert.ok(p.indexOf("- rooms:") > 0 && p.indexOf("- rooms:") < p.indexOf("- is_property:"));
}

// 読みの結果から部屋ごとの帖数を取り出す（決まった名前・2〜40帖だけ）
const r = parseReadResult(JSON.stringify({ items: [{ property_name: "テスト", room_number: "402", rent: 80000, floor_plan: "1LDK", rooms: [{ name: "LDK", jo: 10.5 }, { name: "洋室", jo: "6" }, { name: "バルコニー", jo: 3 }, { name: "和室", jo: 99 }] }], is_property: true }));
assert.deepEqual(r.items[0].rooms, [{ name: "LDK", jo: 10.5 }, { name: "洋室", jo: 6 }]);
assert.equal(roomsOf([]), null);
assert.equal(roomsOf("10帖"), null);
assert.deepEqual(roomsOf([{ name: "ＬＤＫ", jo: 12 }]), [{ name: "LDK", jo: 12 }]);

// rooms が無い読み（off の時）は今と同じ
const r0 = parseReadResult(JSON.stringify({ items: [{ property_name: "テスト", rent: 80000 }], is_property: true }));
assert.equal(r0.items[0].rooms ?? null, null);
assert.equal(factsFromImageRead(r0.items[0]).rooms, undefined);

// 保存（facts.rooms）とブレインへの1行（送った資料の読み取り）
const f = factsFromImageRead({ rent: 80000, floorPlan: "1LDK", rooms: [{ name: "LDK", jo: 10.5 }, { name: "洋室", jo: 6 }] });
assert.deepEqual(f.rooms, [{ name: "LDK", jo: 10.5 }, { name: "洋室", jo: 6 }]);
const line = sentImageFactsLine(f as Record<string, unknown>) ?? "";
assert.ok(line.includes("1LDK・LDK10.5帖・洋室6帖"), line);

console.log("image-read-rooms: ok");
}
main().catch((e) => { console.error(e); process.exit(1); });
