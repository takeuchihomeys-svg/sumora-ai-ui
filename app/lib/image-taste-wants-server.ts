// app/lib/image-taste-wants-server.ts — 好みの手本の画像の特徴を AIX ツールの要望の欄（property_customers の preferences・other_requests）に書く（サーバー専用・LLM なし）
//   2026-11-15 作業員H（竹内さんの決定 KB 1d2400c6・H-14 ②）。判定は customer-image-link（関連＝似た別の物件）と image-taste-wants（足す形）の純関数。
//   呼ぶ所: line-webhook-text のお客様の文を受けた後（画像の後の一言で「こういう・こんな」と分かった時）。既定 off（CUSTOMER_IMAGE_TASTE_WANTS=on）。
//   申込以降の会話・YUMA 以外のテストの会話は触らない。書いたら property_condition_history に残す（書き手 image_taste）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { imageTasteWantsOn, tasteWantUpdates } from "@/app/lib/image-taste-wants";
import { linkTurnImages, imageRoute1115On, type SentForLink } from "@/app/lib/customer-image-link";
import { recordConditionHistory, conditionSourceTag } from "@/app/lib/condition-history";
import { DRAFT_SKIP_STATUSES } from "@/app/lib/conversation-status";

/** 直近の連投（お客様の画像＋一言・30分）から好みの手本の特徴を取り、要望の欄に足す。足した特徴の名前を返す */
export async function applyImageTasteWants(db: SupabaseClient, conversationId: string): Promise<string[]> {
  if (!imageTasteWantsOn() || !imageRoute1115On()) return [];
  const { data: conv } = await db.from("conversations").select("property_customer_id, status").eq("id", conversationId).maybeSingle();
  const c = conv as { property_customer_id?: string | null; status?: string | null } | null;
  if (!c?.property_customer_id || DRAFT_SKIP_STATUSES.has(String(c.status ?? ""))) return [];
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: msgs } = await db.from("messages").select("id, sender, text, image_type, created_at").eq("conversation_id", conversationId).gte("created_at", since).order("created_at", { ascending: true }).limit(40);
  const rows = (msgs ?? []) as Array<{ id: string; sender: string; text: string | null; image_type: string | null; created_at: string }>;
  // 最後のこちらの通より後のお客様の連投だけ
  let start = 0;
  rows.forEach((m, i) => { if (m.sender !== "customer") start = i + 1; });
  const turn = rows.slice(start).filter((m) => m.sender === "customer");
  if (!turn.some((m) => /^\s*\[画像\]/.test(m.text ?? ""))) return [];
  const { data: sp } = await db.from("sent_properties").select("property_name, room_no, sent_at, rent").eq("conversation_id", conversationId).limit(300);
  const sent: SentForLink[] = ((sp ?? []) as Array<{ property_name: string | null; room_no: string | null; sent_at: string | null; rent: number | null }>).filter((r) => r.property_name).map((r) => ({ name: r.property_name as string, room: r.room_no, sentAt: r.sent_at, rent: r.rent }));
  const links = linkTurnImages(turn.map((m) => ({ text: m.text, image_type: m.image_type, created_at: m.created_at })), sent);
  const features = links.flatMap((l) => (l.relation === "similar_other" ? l.taste ?? [] : []));
  if (!features.length) return [];
  const { data: pc } = await db.from("property_customers").select("id, preferences, other_requests, ng_points").eq("id", c.property_customer_id).maybeSingle();
  const cur = pc as { id: string; preferences: string | null; other_requests: string | null; ng_points: string | null } | null;
  if (!cur) return [];
  const u = tasteWantUpdates(cur, features);
  if (!u.added.length) { console.log(JSON.stringify({ tag: "image-taste-wants:none", conversationId, skipped: u.skipped })); return []; }
  const { error } = await db.from("property_customers").update(u.updates).eq("id", cur.id);
  if (error) { console.warn("[image-taste-wants] 書けない:", error.message); return []; }
  const lastImage = [...turn].reverse().find((m) => /^\s*\[画像\]/.test(m.text ?? ""));
  void recordConditionHistory(db, cur.id, cur as unknown as Record<string, unknown>, u.updates, conditionSourceTag("image_taste", lastImage?.id ?? null));
  console.log(JSON.stringify({ tag: "image-taste-wants:added", conversationId, added: u.added, skipped: u.skipped }));
  return u.added;
}
