// app/lib/check-name-fill.ts — 物件名の記録が空の AIX【物件確認した】を、その会話で直前にお客様が送ってきた物件で埋める（1件に決まる時だけ・純関数＋DB の口）
//
// 2026-11-21 作業員K2（統括役・竹内さん「物件確認したのところもちゃんと物件把握できるようにする。お客さんから送ってきた物件をちゃんと理解できていればここは改善される」）。
//   30日の物件名が空の物件確認した 21番（テスト外し・scripts/audit-check-name-fill.ts）: 1件に決まる 4／2件以上 2／持ち込みなし 5／
//   持ち込みはあるが名前が読めない 6（#461 ② G の深い読みの範囲）／URL だけでページを開かないと読めない 4。
//   画面（AixModal）は変えない。①送った後の記録（log-aix-usage の property_names）を埋める ②画面の先入れ（/api/aix/brought-properties）の名前が空の時に入れる。
//   2件以上・決まらない時は空のまま（推測で埋めない・8094f9ed）。
// 名前の元（G と揃えた 11/21）: customer_image_records（certainty high|mid・kind が物件の種類・ours_kind が same_room|same_building でない・
//   name_via portal_title|text|deep_read）＋ customer-sent-property.collectCustomerSentProperties（画像の書き起こし・URL）。号室は room_no が空でない時だけ。
// ■ スイッチ CHECK_NAME_FILL: 既定 off（読まない・記録も先入れも今のまま）／on
// テスト: app/lib/__tests__/check-name-fill.test.ts
type Env = Record<string, string | undefined>;
export function checkNameFillOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.CHECK_NAME_FILL ?? "").trim().toLowerCase() === "on";
}

export type NameCand = { name: string | null; room?: string | null; via: string };
const key = (s: string) => s.normalize("NFKC").replace(/[\s　・･\-‐ー－【】()（）]/g, "").toLowerCase();
const roomKey = (s: string | null | undefined) => String(s ?? "").normalize("NFKC").replace(/[^0-9A-Za-z]/g, "").replace(/^0+(?=\d)/, "");

/** 候補 → 1件に決まる時だけ { name, room, via }。同じ建物で号室が違う・建物が2つ以上・名前が無い → null */
export function resolveCheckPropertyName(cands: ReadonlyArray<NameCand>): { name: string; room: string | null; via: string } | null {
  const xs = cands.filter((c) => (c.name ?? "").trim());
  if (!xs.length) return null;
  const buildings = new Set(xs.map((c) => key(String(c.name))));
  if (buildings.size !== 1) return null;
  const rooms = new Set(xs.map((c) => roomKey(c.room)).filter(Boolean));
  if (rooms.size > 1) return null;
  const withRoom = xs.find((c) => roomKey(c.room));
  const pick = withRoom ?? xs[0];
  return { name: String(pick.name).trim(), room: withRoom ? String(withRoom.room).trim() : null, via: pick.via };
}

/** 記録・先入れに入れる名前（号室があれば「建物 号室」） */
export const filledLabel = (r: { name: string; room: string | null }) => (r.room ? `${r.name} ${r.room}` : r.name);

const PROPERTY_KINDS = new Set(["property_material", "property_screen", "property_ad", "property_photo"]);
const OURS = new Set(["same_room", "same_building"]);
export type ImageRecordRow = { property_name: string | null; room_no: string | null; certainty: string | null; kind: string | null; ours_kind: string | null; name_via: string | null };
/** customer_image_records の行 → 信じてよい候補だけ（G の線） */
export function candsFromImageRecords(rows: ReadonlyArray<ImageRecordRow>): NameCand[] {
  return rows.filter((r) => r.property_name && (r.certainty === "high" || r.certainty === "mid") && PROPERTY_KINDS.has(String(r.kind)) && !OURS.has(String(r.ours_kind)))
    .map((r) => ({ name: r.property_name, room: r.room_no && r.room_no.trim() ? r.room_no : null, via: `image_record:${r.name_via ?? "?"}` }));
}

// ── DB の口（サーバーで使う・72時間のお客様の持ち込み） ──────────────────────────
import type { SupabaseClient } from "@supabase/supabase-js";
export async function loadCheckNameFill(sb: SupabaseClient, conversationId: string, atIso: string, hours = 72): Promise<{ name: string; room: string | null; via: string } | null> {
  const at = Date.parse(atIso);
  const from = new Date(at - hours * 36e5).toISOString(), to = new Date(at).toISOString();
  const [mq, iq] = await Promise.all([
    sb.from("messages").select("sender, text, image_type, created_at").eq("conversation_id", conversationId).gte("created_at", from).lte("created_at", to).order("created_at").limit(300),
    sb.from("customer_image_records").select("property_name, room_no, certainty, kind, ours_kind, name_via").eq("conversation_id", conversationId).gte("created_at", from).lte("created_at", to).limit(50),
  ]);
  const { collectCustomerSentProperties } = await import("./customer-sent-property");
  const { items } = collectCustomerSentProperties((mq.data ?? []) as never, { limit: 10 });
  const cands: NameCand[] = [
    ...items.map((x) => ({ name: x.name, room: null, via: `customer_sent:${x.source}` })),
    ...candsFromImageRecords((iq.data ?? []) as ImageRecordRow[]),
  ];
  return resolveCheckPropertyName(cands);
}
