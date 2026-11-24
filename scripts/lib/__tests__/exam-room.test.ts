// #684 の余地の関所（純関数）のテスト
import assert from "node:assert/strict";
import { roomOf, roomGateMode, type RoomTurn } from "../exam-room";
import { reachRowOf } from "../exam-switch-reach";

const T = (isReply: boolean, mismatch: boolean, pickups = 0): RoomTurn => ({ conv: "c", at: 0, isReply, mismatch, materials: { property_pickups: pickups } });
assert.equal(roomGateMode({}), "warn", "既定は記録だけ");
assert.equal(roomGateMode({ EXAM_ROOM_GATE: "on" }), "on");
assert.equal(roomOf({ minApplicable: 0, onSwitches: ["SOME_PROMPT_SWITCH"], turns: [T(true, true)] }).decision, "unknown", "表に無いスイッチは決めない");
assert.equal(roomOf({ minApplicable: 0, onSwitches: ["PICKUP_WHY_TO_BRAIN"], turns: [T(true, true, 0), T(true, false, 2)] }).decision, "block", "材料のある番に食い違いが無い＝余地0");
const d = roomOf({ minApplicable: 0, onSwitches: ["PICKUP_WHY_TO_BRAIN"], turns: [T(true, true, 1), T(false, false, 1)] });
assert.deepEqual([d.decision, d.applicable, d.room], ["defer", 2, 1]);
assert.equal(roomOf({ minApplicable: 0, onSwitches: ["COMPOSE_CLOSING_TABLE"], turns: [T(true, true), T(true, true), T(true, true), T(false, true)] }).room, 3, "返信の下書きのスイッチは返信の番だけ");
assert.equal(roomOf({ minApplicable: 0, onSwitches: ["PICKUP_WHY_TO_BRAIN"], turns: [] }).decision, "unknown");
console.log("exam-room: ok");

// 2026-11-25: fixes（直す番）がある行は、その番の文の判定だけで効く番を決める
{
  const base = { conv: "c", at: 0, isReply: true, materials: {} };
  const r = roomOf({ minApplicable: 0, onSwitches: ["BRAIN_FAR_OTHER_FIRST"], turns: [{ ...base, mismatch: true, text: "ちょっと遠いので他の候補もありますか" }, { ...base, mismatch: true, text: "内覧したいです" }] });
  assert.deepEqual([r.applicable, r.room], [1, 1], "遠い・他の候補の番だけ");
  const r2 = roomOf({ minApplicable: 0, onSwitches: ["BRAIN_FAR_OTHER_FIRST"], turns: [{ ...base, mismatch: false, text: "遠いので他の物件も" }, { ...base, mismatch: true, text: "ありがとうございます" }] });
  assert.equal(r2.decision, "block", "効く番に食い違いが無い＝余地0");
  console.log("exam-room fixes: ok");
}

// 表を引く入口（learned は置き場が決まるまで空）
{

  const r = reachRowOf("BRAIN_CLOSED_THANKS_NO_REPLY");
  assert.deepEqual([r.inTable, r.fixes?.turn, r.learned.size], [true, "closed_thanks", 0]);
  assert.equal(reachRowOf("NOT_IN_TABLE").inTable, false);
  console.log("reachRowOf: ok");
}

// 2026-11-25: 設備の希望（on と off で読みが違う番だけ）・見積の記録（材料）
{
  const base = { conv: "c", at: 0, isReply: true, mismatch: true };
  const r = roomOf({ minApplicable: 0, onSwitches: ["EQUIPMENT_WISH_LOOKUP"], turns: [{ ...base, materials: {}, text: "独立洗面台が欲しいです" }, { ...base, materials: {}, text: "ありがとうございます" }] });
  assert.equal(r.applicable, 1, "希望の言い方の番だけ");
  const r2 = roomOf({ minApplicable: 0, onSwitches: ["BRAIN_ESTIMATE_RECORDS"], turns: [{ ...base, materials: { estimate_records: 1 } }, { ...base, materials: { estimate_records: 0 } }] });
  assert.equal(r2.applicable, 1, "見積の記録がある会話の番だけ");
  console.log("exam-room equip・estimate: ok");
}

// 2026-11-25: 本番の効く番が少ない時は決めない（h1118-wish3 の型）
{
  const base = { conv: "c", at: 0, isReply: true, mismatch: false, materials: { property_pickups: 1 } };
  assert.equal(roomOf({ onSwitches: ["PICKUP_WHY_TO_BRAIN"], turns: [base, base] }).decision, "unknown", "効く番 2 では余地0と言わない");
  assert.equal(roomOf({ onSwitches: ["PICKUP_WHY_TO_BRAIN"], turns: Array(10).fill(base) }).decision, "block", "効く番 10 で食い違い0なら余地0");
  console.log("exam-room min applicable: ok");
}
