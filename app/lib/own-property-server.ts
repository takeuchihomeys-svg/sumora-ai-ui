// app/lib/own-property-server.ts
// お客様の最新の連投に含まれる物件（スクショ）が、こちらが前に送った物件かを DB の記録で照合する。
// 判定そのものは own-property-match.ts（純関数）。ここは記録を引いて渡すだけ。
// 2026-09-22 竹内（𝓡さん事例）「こっちが送った物件をお客さんが送ってくることもある。判断できるようにする」
import { supabase } from "@/app/lib/supabase";
import { extractScreenshotProperty, matchOwnProperty, buildOwnPropertyNote, type SentProperty } from "@/app/lib/own-property-match";

type Msg = { sender: string; text?: string | null; createdAt?: string | null };

export async function resolveOwnPropertyForTurn(
  conversationId: string | null | undefined,
  recentMessagesOldestFirst: ReadonlyArray<Msg>,
): Promise<{ note: string; all: boolean; items: number; ours: number } | null> {
  if (!conversationId) return null;
  // 最後のこちらの発言より後の、お客様の画像（スクショ）
  const msgs = [...recentMessagesOldestFirst];
  let i = msgs.length - 1;
  const turn: Msg[] = [];
  while (i >= 0 && msgs[i].sender === "customer") { turn.unshift(msgs[i]); i--; }
  const items = turn
    .map((m) => ({ m, item: extractScreenshotProperty(m.text ?? "") }))
    .filter((x): x is { m: Msg; item: NonNullable<ReturnType<typeof extractScreenshotProperty>> } => !!x.item);
  if (items.length === 0) return null;
  try {
    const [{ data: sp }, { data: sip }] = await Promise.all([
      supabase.from("sent_properties").select("property_name, room_no, sent_at").eq("conversation_id", conversationId).limit(300),
      supabase.from("sent_image_properties").select("property_name, room_no, created_at").eq("conversation_id", conversationId).limit(300),
    ]);
    const sent: SentProperty[] = [
      ...((sp ?? []) as Array<{ property_name: string | null; room_no: string | null; sent_at: string | null }>).map((r) => ({ name: r.property_name ?? "", room: r.room_no, sentAt: r.sent_at })),
      ...((sip ?? []) as Array<{ property_name: string | null; room_no: string | null; created_at: string }>).map((r) => ({ name: r.property_name ?? "", room: r.room_no, sentAt: r.created_at })),
    ].filter((s) => s.name);
    const results = items.map(({ m, item }) => ({
      item,
      // お客様が送るより前にこちらが送った物だけ
      match: matchOwnProperty(item, sent.filter((s) => !s.sentAt || !m.createdAt || s.sentAt < m.createdAt)),
    }));
    const ours = results.filter((r) => r.match.kind === "same_room").length;
    const note = buildOwnPropertyNote(results);
    console.log(JSON.stringify({ tag: "reply:own-property", conversationId, items: results.length, ours, sentKnown: sent.length }));
    return { note, all: ours > 0 && ours === results.length, items: results.length, ours };
  } catch (e) {
    console.warn("[own-property] 照合失敗（従来どおり）:", e instanceof Error ? e.message : e);
    return null;
  }
}
