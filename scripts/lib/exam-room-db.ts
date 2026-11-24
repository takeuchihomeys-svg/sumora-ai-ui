// scripts/lib/exam-room-db.ts — #684 の余地の材料を本番の DB から読む（読むだけ・LLM なし）
//   line_watch_turns（照らしの済んだ番・試しの会話は除く）と、材料の表の要る表（会話ごと・番の時刻より前の行の数）と、
//   番の文の判定（fixes.turn）に使うお客様の文・直前のこちらの文（messages・その場で使うだけで残さない・報告に出さない）
import type { SupabaseClient } from "@supabase/supabase-js";
import { readWatchTurns } from "./prod-yardstick-db";
import { SWITCH_REACH } from "./exam-switch-reach";
import type { RoomTurn } from "./exam-room";

const MATERIAL_TABLES = [...new Set(Object.values(SWITCH_REACH).flatMap((d) => d.needs ?? []))];

export async function readRoomTurns(sb: SupabaseClient, sinceIso: string, untilIso: string = new Date().toISOString(), o: { withText?: boolean } = { withText: true }): Promise<RoomTurn[]> {
  const w = (await readWatchTurns(sb, sinceIso)).filter((t) => t.customer_turn_at < untilIso);
  const convs = [...new Set(w.map((t) => t.conversation_id))];
  // 表ごと・会話ごとの行の時刻（番の時刻より前の数を数える）
  const at = new Map<string, Map<string, number[]>>();
  for (const tb of MATERIAL_TABLES) {
    const m = new Map<string, number[]>();
    for (let i = 0; i < convs.length; i += 100) {
      for (let j = 0; ; j += 1000) {
        const { data, error } = await sb.from(tb).select("conversation_id, created_at").in("conversation_id", convs.slice(i, i + 100)).lt("created_at", untilIso).range(j, j + 999);
        if (error) break; // 表が読めない時はその材料を0として扱う（余地を小さく見る側＝warn の間は積むのを止めない）
        for (const r of (data ?? []) as Array<{ conversation_id: string; created_at: string }>) m.set(r.conversation_id, [...(m.get(r.conversation_id) ?? []), Date.parse(r.created_at)]);
        if ((data ?? []).length < 1000) break;
      }
    }
    at.set(tb, m);
  }
  // 会話ごとの通（時刻の順）: お客様の番の文＝その番の時刻以前で、直前のこちらの通より後のお客様の通をつなぐ
  const msgs = new Map<string, Array<{ at: number; customer: boolean; text: string }>>();
  if (o.withText !== false) {
    for (let i = 0; i < convs.length; i += 50) {
      for (let j = 0; ; j += 1000) {
        const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at").in("conversation_id", convs.slice(i, i + 50))
          .gte("created_at", new Date(Date.parse(sinceIso) - 7 * 86_400_000).toISOString()).lt("created_at", untilIso).order("created_at", { ascending: true }).range(j, j + 999);
        if (error) break;
        for (const r of (data ?? []) as Array<{ conversation_id: string; sender: string; text: string | null; created_at: string }>) msgs.set(r.conversation_id, [...(msgs.get(r.conversation_id) ?? []), { at: Date.parse(r.created_at), customer: r.sender === "customer", text: String(r.text ?? "") }]);
        if ((data ?? []).length < 1000) break;
      }
    }
  }
  return w.map((t) => {
    const ts = Date.parse(t.customer_turn_at);
    const materials: Record<string, number> = {};
    for (const tb of MATERIAL_TABLES) materials[tb] = (at.get(tb)?.get(t.conversation_id) ?? []).filter((x) => x <= ts).length;
    const ms = (msgs.get(t.conversation_id) ?? []).filter((m) => m.at <= ts);
    let k = ms.length - 1; const cust: string[] = [];
    while (k >= 0 && ms[k].customer) { cust.unshift(ms[k].text); k--; }
    const lastStaff = k >= 0 ? ms[k].text : null;
    return { conv: t.conversation_id, at: ts, isReply: !String(t.brain_action ?? "").trim(), mismatch: t.verdict === "different" || t.verdict === "partial", materials, scene: t.scene_key, text: cust.join("\n"), lastStaff };
  });
}
