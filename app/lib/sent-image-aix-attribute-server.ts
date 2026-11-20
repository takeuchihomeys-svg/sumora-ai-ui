// app/lib/sent-image-aix-attribute-server.ts — AIX で送った画像（読み取りで物件が分からなかった物）を AIX の記録の物件名に結ぶ（サーバー専用・LLM なし）
//   2026-11-21 作業員G（#448）。判定は sent-image-aix-attribute.ts（純関数）。既定 off（SENT_IMAGE_AIX_ATTRIBUTE=on）。
//   既に物件名の記録がある画像は触らない（読み取りで照合した物・ピックアップの記録を上書きしない）。LINE には何も送らない。
import type { SupabaseClient } from "@supabase/supabase-js";
import { channelFromSource } from "@/app/lib/sent-delivery";
import { pickAixProperty, sentImageAixAttributeOn, AIX_ATTRIBUTE_WINDOW_MS, type AixLogForAttr } from "@/app/lib/sent-image-aix-attribute";

export async function attributeSentImageFromAixLog(db: SupabaseClient, opts: { imageUrl: string; conversationId: string; source: string; sentAt: string }): Promise<"attributed" | "has_record" | "no_match" | "off"> {
  if (!sentImageAixAttributeOn()) return "off";
  const { data: cur } = await db.from("sent_image_properties").select("property_name").eq("image_url", opts.imageUrl).maybeSingle();
  if ((cur as { property_name: string | null } | null)?.property_name) return "has_record";
  const t = Date.parse(opts.sentAt);
  const { data: logs } = await db.from("aix_usage_logs").select("aix_type, property_names, sent_at, created_at").eq("conversation_id", opts.conversationId)
    .gte("created_at", new Date(t - AIX_ATTRIBUTE_WINDOW_MS - 60 * 60_000).toISOString()).lte("created_at", new Date(t + AIX_ATTRIBUTE_WINDOW_MS + 60_000).toISOString()).limit(50);
  const hit = pickAixProperty(opts.source, t, (logs ?? []) as AixLogForAttr[]);
  if (!hit) return "no_match";
  const channel = channelFromSource(`aix:${hit.aixType}`);
  const { error } = await db.from("sent_image_properties").upsert(
    { image_url: opts.imageUrl, conversation_id: opts.conversationId, property_name: hit.name, room_no: hit.room, source: `aix_log:${hit.aixType}`, ...(channel ? { channel } : {}) },
    { onConflict: "image_url", ignoreDuplicates: true }, // 間に読み取りの記録が入っていたら上書きしない
  );
  if (error) { console.warn(JSON.stringify({ tag: "sent-image-aix-attribute:failed", error: error.message.slice(0, 160) })); return "no_match"; }
  console.log(JSON.stringify({ tag: "sent-image-aix-attribute", conversationId: opts.conversationId, aixType: hit.aixType }));
  return "attributed";
}
