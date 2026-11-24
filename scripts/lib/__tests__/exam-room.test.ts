// #684 の余地の関所（純関数）のテスト
import assert from "node:assert/strict";
import { roomOf, roomGateMode, type RoomTurn } from "../exam-room";

const T = (isReply: boolean, mismatch: boolean, pickups = 0): RoomTurn => ({ conv: "c", at: 0, isReply, mismatch, materials: { property_pickups: pickups } });
assert.equal(roomGateMode({}), "warn", "既定は記録だけ");
assert.equal(roomGateMode({ EXAM_ROOM_GATE: "on" }), "on");
assert.equal(roomOf({ onSwitches: ["SOME_PROMPT_SWITCH"], turns: [T(true, true)] }).decision, "unknown", "表に無いスイッチは決めない");
assert.equal(roomOf({ onSwitches: ["PICKUP_WHY_TO_BRAIN"], turns: [T(true, true, 0), T(true, false, 2)] }).decision, "block", "材料のある番に食い違いが無い＝余地0");
const d = roomOf({ onSwitches: ["PICKUP_WHY_TO_BRAIN"], turns: [T(true, true, 1), T(false, false, 1)] });
assert.deepEqual([d.decision, d.applicable, d.room], ["defer", 2, 1]);
assert.equal(roomOf({ onSwitches: ["COMPOSE_CLOSING_TABLE"], turns: [T(true, true), T(true, true), T(true, true), T(false, true)] }).room, 3, "返信の下書きのスイッチは返信の番だけ");
assert.equal(roomOf({ onSwitches: ["PICKUP_WHY_TO_BRAIN"], turns: [] }).decision, "unknown");
console.log("exam-room: ok");
