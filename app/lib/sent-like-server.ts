// app/lib/sent-like-server.ts — 「送ってきた物件・刺さった物件の像」（sent-like-fit.ts）の DB の口
// STAR_SENT_LIKE=on の時だけ読む（既定 off＝何も読まず null）。読むのはそのお客様の会話のお客様の発言（customer-sent-property-server と同じ・申込以降は読まない）と、
// 刺さった送付（sent_properties.customer_reaction='interested'）の値（rent_observations・建物名＋号室）だけ。
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildSentLikeProfile, sentLikeEnabled, type SentLikeItem, type SentLikeProfile } from "./sent-like-fit";

const nameKey = (s: unknown) => String(s ?? "").normalize("NFKC").replace(/[\s　・･\-‐ー－【】()（）]/g, "").toLowerCase();
const roomKey = (s: unknown) => String(s ?? "").normalize("NFKC").replace(/[^0-9A-Za-z]/g, "").replace(/^0+(?=\d)/, "");

export async function loadSentLikeProfile(sb: SupabaseClient, propertyCustomerId: string | null): Promise<SentLikeProfile | null> {
  if (!sentLikeEnabled() || !propertyCustomerId) return null;
  try {
    const items: SentLikeItem[] = [];
    const { data: conv } = await sb.from("conversations").select("id").eq("property_customer_id", propertyCustomerId).order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (conv?.id) {
      const { loadCustomerSentPropertyBlock } = await import("./customer-sent-property-server");
      const r = await loadCustomerSentPropertyBlock(sb, String(conv.id));
      // 申込以降（post_apply_blocked）は items が空で返る＝像に入れない
      for (const x of r.items) items.push({ floorPlan: x.madori, areaSqm: x.areaSqm, ageYears: x.ageYears, walk: x.walk, from: "customer_sent" });
    }
    const { data: inter } = await sb.from("sent_properties").select("property_name, room_no").eq("property_customer_id", propertyCustomerId).eq("customer_reaction", "interested").limit(20);
    const names = [...new Set(((inter ?? []) as Array<{ property_name: string | null }>).map((x) => String(x.property_name ?? "")).filter(Boolean))];
    if (names.length) {
      const { data: ros } = await sb.from("rent_observations").select("property_name, room_no, floor_plan, area_sqm, building_age, walk_minutes").in("property_name", names).limit(200);
      const want = new Set(((inter ?? []) as Array<{ property_name: string | null; room_no: string | null }>).map((x) => `${nameKey(x.property_name)}#${roomKey(x.room_no)}`));
      for (const ro of (ros ?? []) as Array<Record<string, unknown>>) {
        if (!want.has(`${nameKey(ro.property_name)}#${roomKey(ro.room_no)}`)) continue;
        items.push({ floorPlan: (ro.floor_plan as string | null) ?? null, areaSqm: ro.area_sqm != null ? Number(ro.area_sqm) : null, ageYears: (ro.building_age as number | null) ?? null, walk: (ro.walk_minutes as number | null) ?? null, from: "interested" });
      }
    }
    const p = buildSentLikeProfile(items);
    console.log(JSON.stringify({ tag: "star:sent-like", propertyCustomerId, items: items.length, plans: p?.plans ?? null }));
    return p;
  } catch (e) {
    console.warn("[sent-like]", e instanceof Error ? e.message : e);
    return null;
  }
}
