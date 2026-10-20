// app/lib/reaction-negatives-server.ts — 送った物件への反応・メモを DB から読んで reaction-negatives.ts に渡す（読むだけ・LLM なし）
//
// 材料（このお客様に結んだ会話・直近 REACTION_RULE.maxAgeDays 日）:
//   送付 … sent_properties（お客様に届いた送付だけ・isCustomerDelivery）・sent_image_properties（送った画像 → 物件・画像の読みの階・家賃）
//   物件の値 … property_pickups の説明文（parsePropertyFacts＝家賃・徒歩・㎡・築年）・号室の階（floorFromRoom）
//   反応 … messages（お客様の発言・引用返信の引用先の画像）
//   メモ … customer_memos.items（ng・concern・core）
// お客様の文は外に出さない（DeepSeek・Claude に渡さない＝審査の事情の線 screening-sensitive に触れない）。
// 戻す: AIX_REACTIONS_LINK=off（既定 off・loadReactionState は null を返す）

import type { SupabaseClient } from "@supabase/supabase-js";
import { parsePropertyFacts, splitBuildingRoom, normalizeBuildingName, normalizeRoomKey, isCustomerDelivery } from "./property-brain";
import { floorFromRoom } from "./listing-equipment";
import { buildReactionNegatives, reactionsLinkEnabled, REACTION_RULE, type ReactionState, type RxMemo, type RxMsg, type RxProp, type RxSend } from "./reaction-negatives";

export type SentPropRow = { conversation_id: string | null; property_name: string | null; room_no: string | null; sent_at: string; rent?: number | null; delivery?: string | null; source?: string | null; image_url?: string | null };
export type SentImageRow = { conversation_id: string | null; image_url: string | null; property_name: string | null; room_no: string | null; created_at: string; facts?: { rent?: number | null; floor?: number | null; admin_fee_yen?: number | null } | null };
export type PickupFactRow = { property_name: string | null; room_no: string | null; summary_text: string | null; created_at: string };
export type MsgRow = { id: string; conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; quoted_message_id: string | null };
export type MemoRow = { conversation_id: string; items: Array<{ kind?: string; text?: string; property?: string | null; sourceAt?: string | null; updatedAt?: string | null; retiredAt?: string | null; expiresAt?: string | null }> | null };
export type ReactionRows = { sentProps: SentPropRow[]; sentImages: SentImageRow[]; pickups: PickupFactRow[]; msgs: MsgRow[]; memos: MemoRow[] };

export function propKeyOf(name: string | null | undefined, room: string | null | undefined): { key: string; building: string; room: string } {
  const sp = splitBuildingRoom(name);
  const r = normalizeRoomKey(room) || sp.room;
  const b = normalizeBuildingName(sp.building);
  return { key: `${b}|${r}`, building: sp.building, room: r };
}

/** 行から reaction-negatives の入力を組み立てる（純関数・測る台本と同じ物を使う） */
export function assembleReactionInput(rows: ReactionRows): { sends: RxSend[]; msgs: RxMsg[]; memos: RxMemo[] } {
  // 物件の値（説明文が一番新しい行を正）
  const factOf = new Map<string, { rentTotal: number | null; areaSqm: number | null; walk: number | null; age: number | null }>();
  for (const p of [...rows.pickups].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const { key } = propKeyOf(p.property_name, p.room_no);
    const f = parsePropertyFacts(p.summary_text);
    factOf.set(key, { rentTotal: f.rentYen != null ? f.rentYen + (f.adminFeeYen ?? 0) : null, areaSqm: f.areaSqm ?? null, walk: f.walkMinutes, age: f.buildingAge });
    // 号室の分からない送付（建物名だけ）でも引けるように
    const bkey = `${key.split("|")[0]}|`;
    if (!factOf.has(bkey)) factOf.set(bkey, factOf.get(key)!);
  }
  const imagesOf = new Map<string, string[]>();
  const imgFact = new Map<string, { rentTotal: number | null; floor: number | null }>();
  for (const r of rows.sentImages) {
    if (!r.image_url || !r.property_name) continue;
    const { key } = propKeyOf(r.property_name, r.room_no);
    (imagesOf.get(key) ?? imagesOf.set(key, []).get(key)!).push(r.image_url);
    const f = r.facts ?? null;
    if (f && (f.rent != null || f.floor != null)) imgFact.set(key, { rentTotal: f.rent != null ? f.rent + (f.admin_fee_yen ?? 0) : null, floor: f.floor ?? null });
  }
  const propOf = (name: string | null, room: string | null, rent: number | null | undefined): RxProp | null => {
    if (!name) return null;
    const k = propKeyOf(name, room);
    const f = factOf.get(k.key) ?? factOf.get(`${k.key.split("|")[0]}|`) ?? null;
    const im = imgFact.get(k.key) ?? null;
    return {
      key: k.key, name: k.building,
      floor: floorFromRoom(k.room) ?? im?.floor ?? null,
      rentTotal: f?.rentTotal ?? im?.rentTotal ?? (rent && rent > 0 ? rent : null),
      areaSqm: f?.areaSqm ?? null, walk: f?.walk ?? null, age: f?.age ?? null,
      imageUrls: imagesOf.get(k.key) ?? [],
    };
  };
  const sends: RxSend[] = [];
  for (const r of rows.sentProps) {
    if (!r.conversation_id || !isCustomerDelivery(r)) continue;
    const p = propOf(r.property_name, r.room_no, r.rent);
    if (p) sends.push({ conv: r.conversation_id, at: r.sent_at, props: [p] });
  }
  for (const r of rows.sentImages) {
    if (!r.conversation_id) continue;
    const p = propOf(r.property_name, r.room_no, null);
    if (p) sends.push({ conv: r.conversation_id, at: r.created_at, props: [p] });
  }
  const imgById = new Map(rows.msgs.map((m) => [m.id, m.image_url]));
  const msgs: RxMsg[] = rows.msgs.filter((m) => m.sender === "customer" && (m.text ?? "").trim()).map((m) => ({
    conv: m.conversation_id, at: m.created_at, text: m.text, quotedImageUrl: m.quoted_message_id ? imgById.get(m.quoted_message_id) ?? null : null,
  }));
  const memos: RxMemo[] = rows.memos.flatMap((r) => (r.items ?? []).map((it) => ({
    kind: String(it.kind ?? ""), text: String(it.text ?? ""), property: it.property ?? null,
    at: it.sourceAt ?? it.updatedAt ?? null, retired: !!it.retiredAt, expiresAt: it.expiresAt ?? null,
  })));
  return { sends, msgs, memos };
}

/** このお客様の材料を読む（since〜until・until が無ければ今） */
export async function loadReactionRows(sb: SupabaseClient, propertyCustomerId: string, o: { sinceIso: string; untilIso?: string | null; convIds?: string[] | null }): Promise<ReactionRows> {
  const until = o.untilIso ?? new Date().toISOString();
  const convIds = o.convIds ?? ((await sb.from("conversations").select("id").eq("property_customer_id", propertyCustomerId).limit(20)).data ?? []).map((c: { id: string }) => c.id);
  const sinceSend = new Date(Date.parse(o.sinceIso) - REACTION_RULE.replyHours * 3_600_000).toISOString();
  const [sp, si, pk, ms, mm] = await Promise.all([
    sb.from("sent_properties").select("conversation_id, property_name, room_no, sent_at, rent, delivery, source, image_url").eq("property_customer_id", propertyCustomerId).gte("sent_at", sinceSend).lte("sent_at", until).limit(1000),
    convIds.length ? sb.from("sent_image_properties").select("conversation_id, image_url, property_name, room_no, created_at, facts").in("conversation_id", convIds).gte("created_at", sinceSend).lte("created_at", until).limit(1000) : Promise.resolve({ data: [] }),
    sb.from("property_pickups").select("property_name, room_no, summary_text, created_at").eq("property_customer_id", propertyCustomerId).gte("created_at", new Date(Date.parse(sinceSend) - 30 * 86_400_000).toISOString()).lte("created_at", until).limit(1000),
    convIds.length ? sb.from("messages").select("id, conversation_id, sender, text, image_url, created_at, quoted_message_id").in("conversation_id", convIds).gte("created_at", sinceSend).lte("created_at", until).order("created_at").limit(3000) : Promise.resolve({ data: [] }),
    convIds.length ? sb.from("customer_memos").select("conversation_id, items").in("conversation_id", convIds) : Promise.resolve({ data: [] }),
  ]);
  const msgs = ((ms as { data: unknown }).data ?? []) as MsgRow[];
  // 引用先が窓の外の発言なら引く（画像の URL だけ）
  const have = new Set(msgs.map((m) => m.id));
  const missing = [...new Set(msgs.map((m) => m.quoted_message_id).filter((v): v is string => !!v && !have.has(v)))].slice(0, 200);
  if (missing.length) {
    const { data } = await sb.from("messages").select("id, conversation_id, sender, text, image_url, created_at, quoted_message_id").in("id", missing);
    for (const r of (data ?? []) as MsgRow[]) msgs.push({ ...r, sender: r.sender === "customer" ? "quoted_customer" : r.sender, text: null });
  }
  return {
    sentProps: ((sp as { data: unknown }).data ?? []) as SentPropRow[],
    sentImages: ((si as { data: unknown }).data ?? []) as SentImageRow[],
    pickups: ((pk as { data: unknown }).data ?? []) as PickupFactRow[],
    msgs,
    memos: ((mm as { data: unknown }).data ?? []) as MemoRow[],
  };
}

/** 判定に渡す反応の状態（AIX_REACTIONS_LINK が on の時だけ・読めない時は null＝今まで通り） */
export async function loadReactionState(sb: SupabaseClient, propertyCustomerId: string | null | undefined, now: Date = new Date()): Promise<ReactionState | null> {
  if (!propertyCustomerId || !reactionsLinkEnabled()) return null;
  try {
    const rows = await loadReactionRows(sb, propertyCustomerId, { sinceIso: new Date(now.getTime() - REACTION_RULE.maxAgeDays * 86_400_000).toISOString(), untilIso: now.toISOString() });
    const st = buildReactionNegatives({ ...assembleReactionInput(rows), now });
    console.log(JSON.stringify({ tag: "reaction-negatives", pc: propertyCustomerId.slice(0, 8), negatives: st.negatives.map((x) => `${x.attr}:${x.scope}:${x.ref ?? "-"}${x.hard ? ":hard" : ""}`), props: Object.keys(st.perProperty).length }));
    return st;
  } catch (e) {
    console.warn("[reaction-negatives] 読めないので反応を使わない:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
