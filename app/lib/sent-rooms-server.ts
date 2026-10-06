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
import { familyIdsFor } from "@/app/lib/customer-family";

export type SentRoom = { name: string; room: string };

/**
 * opts.beforeIso（2026-09-30 v2.5.42 見張り）: その時刻より前に送った物だけ（検索の回の後に送った部屋を「選んだのは誤り」と数えない）
 * opts.customerOnly（送る側）: お客様に届けた物だけ（★物件出し★への共有 delivery=shared を除く＝pickup-sent-badge と同じ）
 */
export async function sentRoomsFor(sb: SupabaseClient, customerId: string, opts: { beforeIso?: string | null; customerOnly?: boolean } = {}): Promise<{ rooms: SentRoom[]; rows: number; without_room: number; error: string | null }> {
  const out = new Map<string, SentRoom>();
  let rows = 0, withoutRoom = 0;
  const take = (list: Array<{ property_name: string | null; room_no: string | null; delivery?: string | null }>) => {
    for (const r of list) {
      if (opts.customerOnly && r.delivery === "shared") continue;
      rows++;
      const name = String(r.property_name ?? "").trim();
      const room = String(r.room_no ?? "").trim();
      if (!name || !room) { withoutRoom++; continue; }
      const k = `${name}|${room}`;
      if (!out.has(k)) out.set(k, { name: name.slice(0, 80), room: room.slice(0, 12) });
    }
  };
  // 2026-10-06 v2.5.78: 2つ目の探し物（子の行）は親の会話で届けた物も同じ人の送付済み（customer-family.ts）
  const ids = await familyIdsFor(sb, customerId);
  let qa = sb.from("sent_properties").select("property_name, room_no, delivery").in("property_customer_id", ids.length ? ids : [customerId]);
  if (opts.beforeIso) qa = qa.lt("sent_at", opts.beforeIso);
  const a = await qa.limit(5000);
  if (a.error) return { rooms: [], rows: 0, without_room: 0, error: a.error.message };
  take((a.data ?? []) as Array<{ property_name: string | null; room_no: string | null }>);
  const conv = await sb.from("conversations").select("id").in("property_customer_id", ids.length ? ids : [customerId]).limit(10);
  const convIds = ((conv.data ?? []) as Array<{ id: string }>).map((c) => c.id);
  if (convIds.length) {
    let qb = sb.from("sent_properties").select("property_name, room_no, delivery").in("conversation_id", convIds).is("property_customer_id", null);
    if (opts.beforeIso) qb = qb.lt("sent_at", opts.beforeIso);
    const b = await qb.limit(5000);
    if (!b.error) take((b.data ?? []) as Array<{ property_name: string | null; room_no: string | null }>);
  }
  return { rooms: [...out.values()], rows, without_room: withoutRoom, error: null };
}
