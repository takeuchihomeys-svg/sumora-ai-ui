// app/lib/customer-image-deep-read-server.ts — お客様が送った物件の画像を DeepSeek で深く読み、customer_image_records の空の欄を埋める（サーバー専用）
//   2026-11-21 作業員G（台帳 #461 ②）。決まりは customer-image-deep-read.ts（純関数）。既定 off（CUSTOMER_IMAGE_DEEP_READ=on）。
//   読みは送った画像と同じ sharedPropertyImageRead（同じ URL は1回・使用量は llm_usage_logs に残る）。
//   申込中の会話（loadDeepseekCutoff の線より前）は読まない。物件の種類の画像だけ（書類・人・ペット・見積は読まない）。
//   失敗してもお客様への返信・ブレインは止めない（記録を埋めるだけ）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { CUSTOMER_IMAGE_DEEP_READ_VERSION, customerImageDeepReadOn, deepReadNeeded, deepReadPatch } from "@/app/lib/customer-image-deep-read";

export async function deepReadCustomerImages(db: SupabaseClient, messageIds: ReadonlyArray<string>, opts?: { limit?: number }): Promise<{ read: number; filled: number }> {
  const out = { read: 0, filled: 0 };
  if (!customerImageDeepReadOn() || !messageIds.length) return out;
  const { data: recs } = await db.from("customer_image_records")
    .select("message_id, conversation_id, created_at, kind, property_name, room_no, rent_yen, admin_yen, madori, area_sqm, station, walk_min, age_years")
    .in("message_id", [...messageIds].slice(0, 50));
  type Rec = { message_id: string; conversation_id: string; created_at: string; kind: string; property_name: string | null; room_no: string | null; rent_yen: number | null; admin_yen: number | null; madori: string | null; area_sqm: number | null; station: string | null; walk_min: number | null; age_years: number | null };
  const targets = ((recs ?? []) as Rec[]).filter((r) => deepReadNeeded(r).need).slice(0, opts?.limit ?? 5);
  if (!targets.length) return out;
  const [{ sharedPropertyImageRead, SENT_IMAGE_READ_TIMEOUT_MS }, { loadDeepseekCutoff, isAfterCutoff }] = await Promise.all([
    import("@/app/lib/property-image-read"),
    import("@/app/lib/post-apply"),
  ]);
  const cutoffs = new Map<string, Awaited<ReturnType<typeof loadDeepseekCutoff>>>();
  for (const r of targets) {
    try {
      if (!cutoffs.has(r.conversation_id)) cutoffs.set(r.conversation_id, await loadDeepseekCutoff(db as never, r.conversation_id));
      if (!isAfterCutoff(r.created_at, cutoffs.get(r.conversation_id))) {
        console.log(JSON.stringify({ tag: "deepseek-cutoff:skip-image-read", route: "customer-image-deep-read", conversationId: r.conversation_id }));
        continue;
      }
      const { data: m } = await db.from("messages").select("image_url").eq("id", r.message_id).maybeSingle();
      const url = (m as { image_url: string | null } | null)?.image_url ?? null;
      if (!url || !/^https?:\/\//.test(url)) continue;
      const res = await sharedPropertyImageRead(url, { timeoutMs: SENT_IMAGE_READ_TIMEOUT_MS, conversationId: r.conversation_id });
      out.read++;
      if (!res.isProperty) continue;
      const patch = deepReadPatch(r, res.items);
      if (!Object.keys(patch).length) continue;
      const { error } = await db.from("customer_image_records").update({
        ...patch,
        ...(patch.property_name ? { name_via: "deep_read" } : {}),
        read_version: CUSTOMER_IMAGE_DEEP_READ_VERSION,
      }).eq("message_id", r.message_id);
      if (!error) out.filled++;
    } catch (e) {
      console.warn("[customer-image-deep-read] 失敗:", e instanceof Error ? e.message : e);
    }
  }
  console.log(JSON.stringify({ tag: "customer-image-deep-read", targets: targets.length, ...out }));
  return out;
}
