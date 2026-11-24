// scripts/lib/exam-room.ts — 本番の照らしで「直しに余地があるか」を先に見る（台帳 #684・2026-11-25 作業員L・純関数）
//   統括役の了承の設計: スイッチを積む前に、本番の直近14日の番（line_watch_turns＝ブレインの判断と実際の一手の照らし）から
//   そのスイッチが効く番（材料の表 SWITCH_REACH の要る材料が会話にある・場面の表 SWITCH_SCENE の返信の下書き＝ブレインが返信を選んだ番）を数え、
//   その中で実際の一手と食い違った番（verdict=different・partial）＝余地を数える。
//   決め: 表に無いスイッチがある→決めない（余地が分からない）／余地0→積まない／余地1〜2→後回し／余地3以上→積む
//   入れ方: EXAM_ROOM_GATE=off|warn|on（既定 warn＝記録だけ）。on にするのは前の晩の組になぞって「余地0なのに良くなった組」が0件の時
import { SWITCH_REACH, type SwitchReachDef } from "./exam-switch-reach";
import { SWITCH_SCENE } from "./exam-narrow";

export type RoomTurn = { conv: string; at: number; isReply: boolean; mismatch: boolean; materials: Readonly<Record<string, number>> };
export type RoomDecision = "unknown" | "block" | "defer" | "ok";
export type RoomResult = { decision: RoomDecision; applicable: number; room: number; turns: number; why: string };
export const ROOM_MIN_OK = 3;

export function roomGateMode(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): "off" | "warn" | "on" {
  const v = (env.EXAM_ROOM_GATE ?? "").trim().toLowerCase();
  return v === "off" ? "off" : v === "on" ? "on" : "warn";
}

export function roomOf(o: { onSwitches: readonly string[]; turns: readonly RoomTurn[]; table?: Record<string, SwitchReachDef>; scene?: Readonly<Record<string, { where: string }>> }): RoomResult {
  const table = o.table ?? SWITCH_REACH, scene = o.scene ?? SWITCH_SCENE;
  const sw = o.onSwitches.filter(Boolean);
  if (!sw.length) return { decision: "unknown", applicable: 0, room: 0, turns: o.turns.length, why: "on のスイッチが無い" };
  const unknown = sw.filter((s) => !(table[s]?.needs?.length) && !scene[s]);
  if (unknown.length) return { decision: "unknown", applicable: 0, room: 0, turns: o.turns.length, why: `材料・場面の表に無いスイッチ（${unknown.join(",")}）＝効く番が分からない` };
  if (!o.turns.length) return { decision: "unknown", applicable: 0, room: 0, turns: 0, why: "本番の照らしの番が無い" };
  const applies = (t: RoomTurn) => sw.some((s) => (table[s]?.needs ?? []).some((n) => (t.materials[n] ?? 0) > 0) || (scene[s]?.where === "reply_draft" && t.isReply));
  const ap = o.turns.filter(applies);
  const room = ap.filter((t) => t.mismatch).length;
  const decision: RoomDecision = room === 0 ? "block" : room < ROOM_MIN_OK ? "defer" : "ok";
  return { decision, applicable: ap.length, room, turns: o.turns.length, why: `効く番 ${ap.length}/${o.turns.length}・食い違い（余地）${room}` };
}
