// app/lib/pickup-sent-plan.ts
// 売上サポ「📤 AIXで送る」で送り終えた時に、ピックアップの行から sent_properties に何を書くかを決める（純関数）。
//
// 2026-09-24 竹内「どれ物件ピックアップで送ったか物件オススメで送ったかもわかる」:
//   旧は送った画像を DeepSeek で読み直し、会話の物件名と照合できないと経路を捨てて source='vision' と記録していた
//   （YUMA のピックアップ送信3回は全部 vision）。ピックアップの行には物件名・号室・AD が全部あるので、そこから直接書く。
//
// ■ 決まり（誤記録0を優先）
//   ・送った画像の数とピックアップ（画像あり）の数が合わない（スタッフがモーダルで外した・足した）なら何も書かない。
//     その時は画像の読み取り（recordSentImageProperty）が aix_type=property_send で1枚ずつ channel=pickup で記録するので経路は失われない。
//     送っていない物件を「送った」と書かない方を採る。
//   ・同じ pickup_id の行が既にあれば書かない（冪等・DB にも部分一意インデックス uq_sent_props_pickup）。
//   ・画像の読み取りが先に書いた行（お客様向け・同じ画像か、同じ物件で2時間以内）には update で合流する（二重にしない）。
//   ・グループに共有した行（line_group）には合流しない。共有した時刻と送った時刻を別の行として残す。
//   ・property_url は入れない: normalizePropertyUrl は realnetpro の ?id= を落とし、全物件共通の値
//     'www.realnetpro.com/common/factsheet.php' になる（30日の4,474行が全部この値）。入れると skip-sent の誤除外が増える。
//     URL は pickup_id → property_pickups.pdf_url でたどれる。
import { isSameProperty, normalizeRoomNo } from "./sent-property-record";
import { isCustomerRow, rowChannel } from "./sent-delivery";

export type PickupForRecord = {
  id: number;
  rank: number;
  property_name: string;
  room_no: string | null;
  ad_yen: number | null;
  trim_image_url: string | null;
  page_image_url: string | null;
};

export type ExistingSentRow = {
  id: string;
  property_name: string | null;
  room_no: string | null;
  image_url: string | null;
  source: string | null;
  delivery?: string | null;
  channel?: string | null;
  pickup_id?: number | null;
  sent_at: string | null;
  ad_yen?: number | null;
};

export type PickupSentInsert = {
  conversation_id: string;
  property_customer_id: string | null;
  property_name: string;
  room_no: string;
  image_url: string | null;
  source: "aix:property_send";
  delivery: "customer";
  channel: "pickup";
  pickup_id: number;
  ad_yen: number | null;
  sent_at: string;
  property_url: null;
};

export type PickupSentUpdate = { id: string; pickupId: number; patch: Record<string, unknown> };
export type PickupImageRow = { image_url: string; conversation_id: string; property_name: string; room_no: string | null; source: "aix:property_send"; channel: "pickup" };
export type PickupSkip = { pickupId: number; reason: "already" | "image_count_mismatch" };

export const MERGE_WINDOW_MS = 2 * 60 * 60 * 1000;

export function planPickupSentWrites(input: {
  pickups: PickupForRecord[];
  /** 実際に届いた画像の URL（送った順）。null＝画像の情報が無い（古い画面・画像の対応は付けない） */
  deliveredImageUrls: string[] | null;
  existing: ExistingSentRow[];
  conversationId: string;
  propertyCustomerId: string | null;
  now: string;
}): { inserts: PickupSentInsert[]; updates: PickupSentUpdate[]; imageRows: PickupImageRow[]; skipped: PickupSkip[] } {
  const inserts: PickupSentInsert[] = [];
  const updates: PickupSentUpdate[] = [];
  const imageRows: PickupImageRow[] = [];
  const skipped: PickupSkip[] = [];

  const pickups = [...input.pickups].sort((a, b) => a.rank - b.rank || a.id - b.id);
  const imgOf = (p: PickupForRecord) => p.trim_image_url ?? p.page_image_url ?? null;
  const withImage = pickups.filter((p) => !!imgOf(p));

  // 画像の数が合わない → 位置で対応を付けられないので何も書かない（誤記録0）
  if (input.deliveredImageUrls && input.deliveredImageUrls.length !== withImage.length) {
    return { inserts, updates, imageRows, skipped: pickups.map((p) => ({ pickupId: p.id, reason: "image_count_mismatch" as const })) };
  }
  const imageFor = new Map<number, string>();
  if (input.deliveredImageUrls) withImage.forEach((p, i) => imageFor.set(p.id, input.deliveredImageUrls![i]));

  const nowMs = Date.parse(input.now);
  const used = new Set<string>();
  for (const p of pickups) {
    if (input.existing.some((e) => e.pickup_id === p.id)) { skipped.push({ pickupId: p.id, reason: "already" }); continue; }
    const img = imageFor.get(p.id) ?? null;
    const roomNo = normalizeRoomNo(p.room_no);
    const target = { property_name: p.property_name, room_no: roomNo };
    // 画像の読み取りが先に書いた行へ合流（お客様向け・pickup_id がまだ無い行だけ。共有の行は対象外）
    // 2026-09-24 反証: 名前と時刻で合流するのは、経路が分からない行（vision 等）か経路 pickup の行だけ。
    //   オススメ・物件確認などで送った行に合流すると channel が pickup に化け、オススメで送った記録が消える → その時は新しい行を入れる
    const hit = input.existing.find((e) => {
      if (used.has(e.id) || e.pickup_id != null || !isCustomerRow(e)) return false;
      if (img && e.image_url === img) return true;
      const ch = rowChannel(e);
      if (ch !== null && ch !== "pickup") return false;
      const t = Date.parse(e.sent_at ?? "");
      return Number.isFinite(t) && Math.abs(nowMs - t) <= MERGE_WINDOW_MS
        && isSameProperty({ property_name: e.property_name ?? "", room_no: e.room_no }, target);
    });
    if (hit) {
      used.add(hit.id);
      const patch: Record<string, unknown> = { pickup_id: p.id, delivery: "customer" };
      // 同じ画像の行でも、既に別の経路が付いていれば上書きしない（経路が分からない行だけ pickup を補う）
      const hitChannel = rowChannel(hit);
      if (hitChannel === null) patch.channel = "pickup";
      if (!hit.image_url && img) patch.image_url = img;
      if (hit.ad_yen == null && p.ad_yen != null) patch.ad_yen = p.ad_yen;
      if (hit.source === "vision" && (hitChannel === null || hitChannel === "pickup")) patch.source = "aix:property_send";
      updates.push({ id: hit.id, pickupId: p.id, patch });
    } else {
      inserts.push({
        conversation_id: input.conversationId,
        property_customer_id: input.propertyCustomerId,
        property_name: p.property_name,
        room_no: roomNo,
        image_url: img,
        source: "aix:property_send",
        delivery: "customer",
        channel: "pickup",
        pickup_id: p.id,
        ad_yen: p.ad_yen ?? null,
        sent_at: input.now,
        property_url: null,
      });
    }
    if (img) imageRows.push({ image_url: img, conversation_id: input.conversationId, property_name: p.property_name, room_no: roomNo || null, source: "aix:property_send", channel: "pickup" });
  }
  return { inserts, updates, imageRows, skipped };
}
