// app/lib/pickup-sent-record.ts
// 売上サポから送り終えたピックアップを sent_properties に記録する（サーバー側・薄い書き込み）。
// 何を書くかの判断は app/lib/pickup-sent-plan.ts の planPickupSentWrites（純関数・テスト付き）。
//
// 2026-09-24 竹内「どれ物件ピックアップで送ったか物件オススメで送ったかもわかる」
//   ・経路は channel='pickup'、source='aix:property_send'、delivery='customer'、pickup_id で property_pickups に戻れる
//   ・同じ画像を後から読み取る recordSentImageProperty は、ここで先に書いた sent_image_properties を既読として使い
//     （DeepSeek を呼ばない）、sent_properties の image_url 一致で duplicate_skipped になる（二重にしない）
import { supabase } from "@/app/lib/supabase";
import { planPickupSentWrites, type ExistingSentRow, type PickupForRecord } from "@/app/lib/pickup-sent-plan";

export type PickupSentRecordResult = { inserted: number; updated: number; images: number; skipped: string[]; error?: string };

const EXISTING_COLS = "id, property_name, room_no, image_url, source, delivery, channel, pickup_id, sent_at, ad_yen";

export async function recordPickupSent(opts: {
  pickups: Array<PickupForRecord & { conversation_id: string | null; property_customer_id: string | null }>;
  deliveredImageUrls: string[] | null;
  conversationId?: string | null;
  propertyCustomerId?: string | null;
  now?: string;
}): Promise<PickupSentRecordResult> {
  const out: PickupSentRecordResult = { inserted: 0, updated: 0, images: 0, skipped: [] };
  const conversationId = opts.conversationId ?? opts.pickups.find((p) => p.conversation_id)?.conversation_id ?? null;
  try {
    // sent_properties は会話で引かれる（ブレイン・重複注意・拡張）ので、会話が無ければ書かない
    if (!conversationId || opts.pickups.length === 0) { out.skipped.push("no_conversation"); return out; }
    let pcid = opts.propertyCustomerId ?? opts.pickups.find((p) => p.property_customer_id)?.property_customer_id ?? null;
    if (!pcid) {
      const { data: conv } = await supabase.from("conversations").select("property_customer_id").eq("id", conversationId).maybeSingle();
      pcid = (conv as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;
    }
    const ids = opts.pickups.map((p) => p.id);
    const [byConv, byPickup] = await Promise.all([
      supabase.from("sent_properties").select(EXISTING_COLS).eq("conversation_id", conversationId).order("sent_at", { ascending: false }).limit(200),
      supabase.from("sent_properties").select(EXISTING_COLS).in("pickup_id", ids),
    ]);
    if (byConv.error) throw new Error(byConv.error.message);
    if (byPickup.error) throw new Error(byPickup.error.message);
    const existingMap = new Map<string, ExistingSentRow>();
    for (const r of [...(byConv.data ?? []), ...(byPickup.data ?? [])] as ExistingSentRow[]) existingMap.set(r.id, r);

    const plan = planPickupSentWrites({
      pickups: opts.pickups,
      deliveredImageUrls: opts.deliveredImageUrls,
      existing: [...existingMap.values()],
      conversationId,
      propertyCustomerId: pcid,
      now: opts.now ?? new Date().toISOString(),
    });
    out.skipped.push(...plan.skipped.map((s) => `${s.pickupId}:${s.reason}`));

    for (const u of plan.updates) {
      const { error } = await supabase.from("sent_properties").update(u.patch).eq("id", u.id).is("pickup_id", null);
      if (error) out.skipped.push(`${u.pickupId}:update_error:${error.message}`);
      else out.updated++;
    }
    for (const row of plan.inserts) {
      // 1行ずつ入れる（同時に2回呼ばれた時、一意インデックスに当たった行だけを「既に記録済み」にする）
      const { error } = await supabase.from("sent_properties").insert(row);
      if (!error) out.inserted++;
      else if ((error as { code?: string }).code === "23505") out.skipped.push(`${row.pickup_id}:already`);
      else out.skipped.push(`${row.pickup_id}:insert_error:${error.message}`);
    }
    if (plan.imageRows.length > 0) {
      // ピックアップの名前が正しいので上書きする（画像の読み取りはこの行を既読として使い、読み直さない）
      const { error } = await supabase.from("sent_image_properties").upsert(plan.imageRows, { onConflict: "image_url" });
      if (error) out.skipped.push(`image_rows_error:${error.message}`);
      else out.images = plan.imageRows.length;
    }
    return out;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  } finally {
    console.log(JSON.stringify({ tag: "pickup-sent-record", conversationId, ...out }));
  }
}
