// app/lib/property-pickups-server.ts
// merge-pdfs の後段で、1回分のピックアップを property_pickups に残す（PDF の文字層・判定・🌟・物件ごとの PDF）。
// 判定は property-brain（純関数）。行の作り方は property-pickups.ts（純関数）。ここは材料を引いて書くだけ。失敗しても投げない。
//
// 2026-09-24 竹内「ピックアップしたのを一度アプリの売上サポに飛ばして、DeepSeek が送る物件とオススメを判断して共有。
//   スタッフは確認してお客さんに送るだけ」
import { supabase } from "@/app/lib/supabase";
import { extractPdfText } from "@/app/lib/pdf-text";
import { buildPickupRows, type PickupItemInput } from "@/app/lib/property-pickups";
import { buildCustomerProfile, judgeProperty, parsePropertyFacts, type CustomerLike, type SentRowLike, type PatternRowLike, type Judgment } from "@/app/lib/property-brain";
import { loadCustomerProfit } from "@/app/lib/estimate-profit-server";

export type RecordPickupInput = {
  batchId: string;
  propertyCustomerId: string | null;
  conversationId: string | null;
  customerName: string | null;
  site: string | null;
  /** 🌟 付きの説明文（merge-pdfs の rankAndAnnotateSummaries の後） */
  summaries: string[];
  /** 説明文と同じ並びの印刷用 PDF の URL（無い時は null） */
  pdfUrls: Array<string | null>;
  /** 説明文と同じ並びの PDF（base64） */
  pdfBase64List: Array<string | null>;
};

/** お客様の会話（LINE の宛先）を物件顧客から引く（最新1件） */
async function resolveConversationId(propertyCustomerId: string | null, conversationId: string | null): Promise<string | null> {
  if (conversationId) return conversationId;
  if (!propertyCustomerId) return null;
  const { data } = await supabase.from("conversations").select("id").eq("property_customer_id", propertyCustomerId).order("updated_at", { ascending: false }).limit(1);
  return ((data ?? [])[0] as { id?: string } | undefined)?.id ?? null;
}

/** 判定のプロフィール（judge API と同じ材料） */
async function loadProfile(propertyCustomerId: string | null) {
  if (!propertyCustomerId) return null;
  const since = new Date(Date.now() - 180 * 86400_000).toISOString();
  const [custRes, sentRes, patRes, convsRes] = await Promise.all([
    supabase.from("property_customers").select("rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet").eq("id", propertyCustomerId).maybeSingle(),
    supabase.from("sent_properties").select("property_name, rent").eq("property_customer_id", propertyCustomerId).gte("sent_at", since).limit(500),
    supabase.from("property_selection_patterns").select("selling_points, selection_label").eq("property_customer_id", propertyCustomerId).order("created_at", { ascending: false }).limit(60),
    supabase.from("conversations").select("id").eq("property_customer_id", propertyCustomerId).limit(10),
  ]);
  const customer = custRes.data as CustomerLike | null;
  if (!customer) return null;
  const convIds = ((convsRes.data ?? []) as Array<{ id: string }>).map((c) => c.id);
  const profit = await loadCustomerProfit({ propertyCustomerId, conversationIds: convIds });
  return buildCustomerProfile(customer, (sentRes.data ?? []) as SentRowLike[], (patRes.data ?? []) as PatternRowLike[], profit.discountMedianYen);
}

export async function recordPickupBatch(input: RecordPickupInput): Promise<{ rows: number; withText: number; withBlob: number; error: string | null }> {
  const out = { rows: 0, withText: 0, withBlob: 0, error: null as string | null };
  try {
    if (input.summaries.length === 0) return out;
    const conversationId = await resolveConversationId(input.propertyCustomerId, input.conversationId);
    const profile = await loadProfile(input.propertyCustomerId);
    const { put } = await import("@vercel/blob");
    const stamp = Date.now();
    const items: PickupItemInput[] = await Promise.all(input.summaries.map(async (summary, i) => {
      const b64 = input.pdfBase64List[i] ?? null;
      let pdfText: string | null = null;
      let pdfBlobUrl: string | null = null;
      if (b64) {
        const t = await extractPdfText(b64, { maxPages: 2, maxChars: 6000 });
        pdfText = t.text || null;
        try {
          const blob = await put(`pickups/${input.batchId.replace(/\.pdf$/i, "")}_${i + 1}_${stamp}.pdf`, Buffer.from(b64, "base64"), { access: "public", contentType: "application/pdf" });
          pdfBlobUrl = blob.url;
        } catch (e) {
          console.warn("[property-pickups] 物件ごとの PDF を置けない:", e instanceof Error ? e.message : String(e));
        }
      }
      let judgment: Judgment | null = null;
      if (profile) {
        try { judgment = judgeProperty(parsePropertyFacts(summary), profile, i); } catch { judgment = null; }
      }
      return { summary, pdfUrl: input.pdfUrls[i] ?? null, pdfBlobUrl, pdfText, judgment };
    }));
    const rows = buildPickupRows({
      batchId: input.batchId, propertyCustomerId: input.propertyCustomerId, conversationId,
      customerName: input.customerName, site: input.site,
    }, items);
    const { error } = await supabase.from("property_pickups").insert(rows);
    if (error) { out.error = error.message; return out; }
    out.rows = rows.length;
    out.withText = rows.filter((r) => r.pdf_has_text).length;
    out.withBlob = rows.filter((r) => r.pdf_blob_url).length;
    return out;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  } finally {
    console.log(JSON.stringify({ tag: "property-pickups:record", batch: input.batchId.slice(0, 40), customer: input.propertyCustomerId?.slice(0, 8) ?? null, ...out }));
  }
}
