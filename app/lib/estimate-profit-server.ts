// app/lib/estimate-profit-server.ts
// 見積書（AIX【見積書送る】）が送られた時に、物件ごとの割引を estimate_records に残し、
// その物件が物件ピックアップ／物件オススメで送った物件なら AD（候補プール・送付記録）と結び付けて利益も残す。
// 判定は estimate-profit.ts（純関数）。ここは記録を引いて渡し、書くだけ。失敗しても投げない。
//
// 2026-09-24 竹内「AD − 見積書の割引金額が利益。物件オススメ・ピックアップで送った物件なら AD も分かっているはず。連動する」
import { supabase } from "@/app/lib/supabase";
import { parseEstimateItems, linkAdForEstimate, computeProfitYen, summarizeEstimateProfit, type AdSource, type ProfitSummary } from "@/app/lib/estimate-profit";

const POOL_DAYS = 60;
const SENT_DAYS = 180;

/** property_candidate_pools の時刻の列は sent_at（created_at は無い・2026-09-24 実測で 0件になっていた） */
type PoolRow = { sent_at: string; candidates: Array<{ name?: string; rent?: number | null; ad_months?: number | null }> | null };
type SentRow = { property_name: string | null; room_no: string | null; rent: number | null; ad_months?: number | null; ad_yen?: number | null; sent_at: string | null };

/** 見積より前の AD の出所（候補プール・送付記録）を集める */
export async function loadAdSources(opts: { propertyCustomerId: string | null; conversationId: string | null; before: string }): Promise<AdSource[]> {
  const out: AdSource[] = [];
  const { propertyCustomerId, conversationId, before } = opts;
  if (propertyCustomerId) {
    const since = new Date(new Date(before).getTime() - POOL_DAYS * 86400_000).toISOString();
    const { data } = await supabase.from("property_candidate_pools").select("sent_at, candidates")
      .eq("property_customer_id", propertyCustomerId).gte("sent_at", since).lte("sent_at", before)
      .order("sent_at", { ascending: false }).limit(40);
    for (const r of (data ?? []) as PoolRow[]) {
      for (const c of r.candidates ?? []) {
        if (!c?.name) continue;
        out.push({ kind: "candidate_pool", name: String(c.name), adMonths: c.ad_months ?? null, rent: c.rent ?? null, at: r.sent_at });
      }
    }
  }
  let q = supabase.from("sent_properties").select("property_name, room_no, rent, ad_months, ad_yen, sent_at")
    .lte("sent_at", before).gte("sent_at", new Date(new Date(before).getTime() - SENT_DAYS * 86400_000).toISOString())
    .order("sent_at", { ascending: false }).limit(300);
  q = propertyCustomerId ? q.eq("property_customer_id", propertyCustomerId) : q.eq("conversation_id", conversationId ?? "");
  const { data: sent } = await q;
  for (const r of (sent ?? []) as SentRow[]) {
    if (!r.property_name) continue;
    out.push({ kind: "sent_property", name: r.property_name, roomNo: r.room_no, rent: r.rent, adMonths: r.ad_months ?? null, adYen: r.ad_yen ?? null, at: r.sent_at });
  }
  return out;
}

export type RecordEstimateResult = { items: number; recorded: number; linked: number; skipped: string | null };

/**
 * 1通の見積書（AIX ログ）を estimate_records に残す。同じログ・同じ物件は二重に書かない。
 * @param dryRun true なら書かずに結果だけ返す（backfill の下見用）
 */
export async function recordEstimateFromAix(input: {
  aixUsageLogId: string;
  conversationId: string;
  generatedText: string | null | undefined;
  createdAt: string;
  dryRun?: boolean;
}): Promise<RecordEstimateResult> {
  const res: RecordEstimateResult = { items: 0, recorded: 0, linked: 0, skipped: null };
  try {
    const items = parseEstimateItems(input.generatedText);
    res.items = items.length;
    if (items.length === 0) { res.skipped = "no_items"; return res; }
    const { data: conv } = await supabase.from("conversations").select("property_customer_id").eq("id", input.conversationId).maybeSingle();
    const pcId = (conv as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;
    const sources = await loadAdSources({ propertyCustomerId: pcId, conversationId: input.conversationId, before: input.createdAt });
    const rows = items.map((it) => {
      const link = it.propertyName ? linkAdForEstimate(it, sources) : null;
      if (link) res.linked++;
      return {
        aix_usage_log_id: input.aixUsageLogId,
        conversation_id: input.conversationId,
        property_customer_id: pcId,
        item_index: it.index,
        property_name: it.propertyName || null,
        room_no: it.roomNo,
        discount_yen: it.discountYen,
        initial_cost_yen: it.initialCostYen,
        rent: link?.rent ?? null,
        ad_months: link?.adMonths ?? null,
        ad_yen: link?.adYen ?? null,
        ad_source: link?.source ?? null,
        ad_matched_name: link?.matchedName ?? null,
        profit_yen: computeProfitYen(link?.adYen, it.discountYen),
        source: "aix_text",
        estimated_at: input.createdAt,
      };
    });
    if (input.dryRun) { res.recorded = rows.length; return res; }
    const { error } = await supabase.from("estimate_records").upsert(rows, { onConflict: "aix_usage_log_id,item_index", ignoreDuplicates: false });
    if (error) { res.skipped = `insert:${error.message}`; return res; }
    res.recorded = rows.length;
    return res;
  } catch (e) {
    res.skipped = e instanceof Error ? e.message : String(e);
    return res;
  } finally {
    if (!input.dryRun) console.log(JSON.stringify({ tag: "estimate-records", log: input.aixUsageLogId.slice(0, 8), ...res }));
  }
}

/** このお客様（物件顧客 or 会話）の見積の記録から、割引・AD・利益の中央値（判定・ブレインの材料） */
export async function loadCustomerProfit(opts: { propertyCustomerId: string | null; conversationIds: string[] }): Promise<ProfitSummary> {
  try {
    let q = supabase.from("estimate_records").select("discount_yen, ad_yen, profit_yen").order("estimated_at", { ascending: false }).limit(60);
    if (opts.propertyCustomerId) q = q.eq("property_customer_id", opts.propertyCustomerId);
    else if (opts.conversationIds.length > 0) q = q.in("conversation_id", opts.conversationIds);
    else return summarizeEstimateProfit([]);
    const { data } = await q;
    return summarizeEstimateProfit((data ?? []) as Array<{ discount_yen: number | null; ad_yen: number | null; profit_yen: number | null }>);
  } catch {
    return summarizeEstimateProfit([]);
  }
}
