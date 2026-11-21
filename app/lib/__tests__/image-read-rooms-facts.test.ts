// npx tsx app/lib/__tests__/image-read-rooms-facts.test.ts
// 2026-11-21 作業員L（#427 の続き）: 部屋ごとの帖数の並べ方・物件の事実の欄・ブレインへの1行（IMAGE_ROOMS_TO_FACTS・既定 off）
import assert from "node:assert/strict";
import { imageRoomsToFactsOn, orderRooms, bedroomsOfMadori, roomsFactsOf } from "../image-read-rooms";
import { factsFromImageRead } from "../candidate-facts";
import { sentImageFactsLine } from "../sent-props-text";
import { judgeRoomJo } from "../room-jo";

assert.equal(imageRoomsToFactsOn({}), false);
assert.equal(imageRoomsToFactsOn({ IMAGE_ROOMS_TO_FACTS: "on" }), true);

// 並べ方: リビング（LDK→LD→DK）→ 居室（広い順）→ K → 他。同じ名前・同じ帖数の重ねは1つ・0.1 帖に丸め
assert.deepEqual(orderRooms([{ name: "洋室", jo: 5 }, { name: "K", jo: 3 }, { name: "ＬＤＫ", jo: 10.53 }, { name: "洋室", jo: 6 }, { name: "洋室", jo: 6 }, { name: "S", jo: 2 }]),
  [{ name: "LDK", jo: 10.5 }, { name: "洋室", jo: 6 }, { name: "洋室", jo: 5 }, { name: "K", jo: 3 }, { name: "S", jo: 2 }]);
assert.deepEqual(orderRooms([{ name: "DK", jo: 7 }, { name: "LDK", jo: 12 }]).map((r) => r.name), ["LDK", "DK"]);
assert.deepEqual(orderRooms([{ name: "", jo: 5 }, { name: "洋室", jo: 0 }, { name: "洋室", jo: Number.NaN }]), []);

assert.equal(bedroomsOfMadori("2LDK"), 2);
assert.equal(bedroomsOfMadori("1K"), 1);
assert.equal(bedroomsOfMadori("ワンルーム"), null);

// 物件の事実の欄（402号室の形: 1LDK・リビング10.5帖・洋室6帖）
const rf = roomsFactsOf([{ name: "洋室", jo: 6 }, { name: "LDK", jo: 10.5 }], "1LDK")!;
assert.equal(rf.living_jo, 10.5);
assert.equal(rf.bedroom_max_jo, 6);
assert.equal(rf.bedroom_count, 1);
assert.equal(rf.count_mismatch, false);
assert.equal(rf.label, "LDK10.5帖・洋室6帖");
// 居室の一番広い帖数は希望の判定（room-jo）にそのまま使える
assert.equal(judgeRoomJo({ jo: 6, approx: false }, rf.bedroom_max_jo), "ok");
// 間取りと居室の数が合わない（言い切らない材料の印）
assert.equal(roomsFactsOf([{ name: "LDK", jo: 10 }, { name: "洋室", jo: 6 }], "2LDK")!.count_mismatch, true);
assert.equal(roomsFactsOf([], "1K"), null);

// 事実の欄への入れ方: 既定 off は今と同じ（rooms だけ）・on で rooms_facts とブレインへの1行が決まった並び
const item = { rent: 80000, floorPlan: "1LDK", rooms: [{ name: "洋室", jo: 6 }, { name: "LDK", jo: 10.5 }] };
delete process.env.IMAGE_ROOMS_TO_FACTS;
const off = factsFromImageRead(item);
assert.equal(off.rooms_facts, undefined);
assert.ok((sentImageFactsLine(off as Record<string, unknown>) ?? "").includes("洋室6帖・LDK10.5帖"));
process.env.IMAGE_ROOMS_TO_FACTS = "on";
const on = factsFromImageRead(item);
assert.equal(on.rooms_facts?.living_jo, 10.5);
assert.ok((sentImageFactsLine(on as Record<string, unknown>) ?? "").includes("1LDK・LDK10.5帖・洋室6帖"), sentImageFactsLine(on as Record<string, unknown>) ?? "");
delete process.env.IMAGE_ROOMS_TO_FACTS;
console.log("image-read-rooms-facts: ok");
