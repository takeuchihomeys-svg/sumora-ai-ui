// app/lib/sent-rooms-server.ts（サーバー専用・読むだけ）
// そのお客様に一度送った部屋（建物名＋号室）の一覧。拡張が検索の一覧で同じ部屋を選ばない（資料をダウンロードしない）ために使う。
//
// 2026-09-29 竹内「一度送ったことがある物件はダウンロードもしないようにすれば更に問題なく物件検索できる。人間の動きのように」
// 出所は sent_properties 1つ（今ある「送付済み」はここに集まる）:
//   ・★物件出し★に共有した部屋（merge-pdfs・delivery=shared）… merge-pdfs は次の送信で建物ごとに外す＝ダウンロードしても捨てるだけ
//   ・お客様に送った部屋（AIX物件ピックアップ pickup-sent-plan・物件確認・画像の読み取り＝delivery=customer）
//   お客様（property_customer_id）で引き、無い行は会話（conversations.property_customer_id）で引く。
//   号室の無い行は返さない（号室が無いと同じ建物の別の部屋と見分けられない＝飛ばさない）。
import type { SupabaseClient } from "@supabase/supabase-js";

export type SentRoom = { name: string; room: string };

export async function sentRoomsFor(sb: SupabaseClient, customerId: string): Promise<{ rooms: SentRoom[]; rows: number; without_room: number; error: string | null }> {
  const out = new Map<string, SentRoom>();
  let rows = 0, withoutRoom = 0;
  const take = (list: Array<{ property_name: string | null; room_no: string | null }>) => {
    for (const r of list) {
      rows++;
      const name = String(r.property_name ?? "").trim();
      const room = String(r.room_no ?? "").trim();
      if (!name || !room) { withoutRoom++; continue; }
      const k = `${name}|${room}`;
      if (!out.has(k)) out.set(k, { name: name.slice(0, 80), room: room.slice(0, 12) });
    }
  };
  const a = await sb.from("sent_properties").select("property_name, room_no").eq("property_customer_id", customerId).limit(5000);
  if (a.error) return { rooms: [], rows: 0, without_room: 0, error: a.error.message };
  take((a.data ?? []) as Array<{ property_name: string | null; room_no: string | null }>);
  const conv = await sb.from("conversations").select("id").eq("property_customer_id", customerId).limit(10);
  const convIds = ((conv.data ?? []) as Array<{ id: string }>).map((c) => c.id);
  if (convIds.length) {
    const b = await sb.from("sent_properties").select("property_name, room_no").in("conversation_id", convIds).is("property_customer_id", null).limit(5000);
    if (!b.error) take((b.data ?? []) as Array<{ property_name: string | null; room_no: string | null }>);
  }
  return { rooms: [...out.values()], rows, without_room: withoutRoom, error: null };
}
