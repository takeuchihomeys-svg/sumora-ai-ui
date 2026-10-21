// app/lib/sent-bundles-server.ts（サーバー専用・DB を読むだけ）: 送った束（sent-bundles.ts）の材料を読む。画面側から import しない
import { supabase } from "@/app/lib/supabase-server";
import { buildSentBundles, sentBundlesEnabled, BUNDLE_STALE_DAYS, type BundleLog, type BundleMsg, type BundleImageRead, type SentBundle } from "@/app/lib/sent-bundles";

/** この会話の直近 days 日の送った束（新しい順）。読めない・止めてある時は [] */
export async function loadSentBundles(conversationId: string, o: { untilIso?: string | null; days?: number } = {}): Promise<SentBundle[]> {
  if (!sentBundlesEnabled() || !conversationId) return [];
  const until = o.untilIso ?? new Date().toISOString();
  const since = new Date(Date.parse(until) - (o.days ?? BUNDLE_STALE_DAYS) * 86_400_000).toISOString();
  try {
    const [{ data: logs }, { data: msgs }] = await Promise.all([
      supabase.from("aix_usage_logs").select("line_message_id, sent_at, created_at, aix_type, check_pattern, property_names, prop_statuses, prop_cost_notes")
        .eq("conversation_id", conversationId).gte("created_at", since).lte("created_at", new Date(Date.parse(until) + 120_000).toISOString()).order("created_at", { ascending: false }).limit(40),
      supabase.from("messages").select("line_message_id, created_at, sender, is_aix_generated, image_url, text")
        .eq("conversation_id", conversationId).eq("is_aix_generated", true).gte("created_at", since).lte("created_at", until).order("created_at", { ascending: false }).limit(200),
    ]);
    const m = (msgs ?? []) as BundleMsg[];
    const urls = [...new Set(m.map((x) => x.image_url).filter((u): u is string => !!u))].slice(0, 120);
    let reads: BundleImageRead[] = [];
    if (urls.length) {
      const [{ data: det }, { data: sip }] = await Promise.all([
        supabase.from("image_details").select("image_url, kind").in("image_url", urls),
        supabase.from("sent_image_properties").select("image_url, property_name, room_no").eq("conversation_id", conversationId).in("image_url", urls),
      ]);
      const by = new Map<string, BundleImageRead>();
      for (const d of (det ?? []) as Array<{ image_url: string; kind: string | null }>) by.set(d.image_url, { image_url: d.image_url, kind: d.kind });
      for (const s of (sip ?? []) as Array<{ image_url: string; property_name: string | null; room_no: string | null }>) by.set(s.image_url, { ...(by.get(s.image_url) ?? { image_url: s.image_url }), property_name: s.property_name, room_no: s.room_no });
      reads = [...by.values()];
    }
    return buildSentBundles((logs ?? []) as BundleLog[], m, reads);
  } catch (e) {
    console.warn("[sent-bundles] 読めない:", conversationId, e instanceof Error ? e.message : String(e));
    return [];
  }
}
