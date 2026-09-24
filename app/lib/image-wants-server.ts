// app/lib/image-wants-server.ts
// 画像で確かめられる希望（image-wants.ts）の材料を DB から集める: 条件欄・お客様の会話（120日）・物件オススメの訴求点。
// 2026-09-24 竹内「画像からしか分からない事を会話から読み取って抜けている部分を入れる。物件オススメで訴求している部分も見れば分かる」
import { supabase } from "@/app/lib/supabase";
import { maskPII } from "@/app/lib/pii-mask";
import { extractImageWants, type ImageWant } from "@/app/lib/image-wants";

export async function loadImageWants(opts: { conversationId: string | null; propertyCustomerId: string | null; staffNote?: string | null }): Promise<ImageWant[]> {
  const since = new Date(Date.now() - 120 * 86400_000).toISOString();
  const [custRes, msgRes, spRes, convRes] = await Promise.all([
    opts.propertyCustomerId
      ? supabase.from("property_customers").select("customer_name, preferences, ng_points, other_requests, additional_conditions, pet").eq("id", opts.propertyCustomerId).maybeSingle()
      : Promise.resolve({ data: null }),
    opts.conversationId
      ? supabase.from("messages").select("text, created_at").eq("conversation_id", opts.conversationId).eq("sender", "customer").gte("created_at", since).order("created_at", { ascending: false }).limit(300)
      : Promise.resolve({ data: [] }),
    opts.propertyCustomerId
      ? supabase.from("property_selection_patterns").select("selling_points, selection_label").eq("property_customer_id", opts.propertyCustomerId).order("created_at", { ascending: false }).limit(60)
      : Promise.resolve({ data: [] }),
    opts.conversationId
      ? supabase.from("conversations").select("customer_name").eq("id", opts.conversationId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const cust = (custRes.data ?? null) as Record<string, string | null> | null;
  const sellingPoints: string[] = [];
  for (const r of (spRes.data ?? []) as Array<{ selling_points: unknown; selection_label: string | null }>) {
    if (r.selection_label === "not_selected") continue;
    for (const p of Array.isArray(r.selling_points) ? r.selling_points : []) sellingPoints.push(String(p));
  }
  return extractImageWants({
    conditions: cust,
    customerMessages: (msgRes.data ?? []) as Array<{ text: string | null; created_at: string | null }>,
    sellingPoints,
    staffNote: opts.staffNote ?? null,
    maskNames: [cust?.customer_name, (convRes.data as { customer_name?: string | null } | null)?.customer_name],
    mask: (t, names) => maskPII(t, names),
  });
}
