// app/lib/customer-sent-property-server.ts（サーバー専用）
// お客様が自分で送ってきた物件（画像・ポータルの URL）を会話から読み、🌟 の順位付け（物件検索ブレイン・DeepSeek）に渡すブロックを作る。
// 純関数・線の説明は customer-sent-property.ts。
//
// 申込以降の線（deepseekSafeCutoff）: 線より後の発言だけ読む。線が引けない会話（null）は渡さない（DeepSeek に出す材料なので）。
// 一言は maskPII（会話のお客様の名前も伏せる）。画像そのものは読まない（受け取った時点の書き起こし＝物件の値だけ）。
// SUUMO のページ（portal-page-read）は新しい方から最大2件・1件ずつ・合わせて 3秒まで・30日以内の URL だけ（同じ URL は1時間覚える）。戻す: CUSTOMER_SENT_PORTAL_FETCH=off
import type { SupabaseClient } from "@supabase/supabase-js";
import { collectCustomerSentProperties, customerSentPropertyBlock, customerSentPropertyEnabled, type CustomerSentProperty } from "./customer-sent-property";
import { loadDeepseekCutoff, filterAfterCutoff, cutoffMs } from "./post-apply";
import { maskPII } from "./pii-mask";
import { readPortalPage, portalUrlsIn, type PortalPage } from "./portal-page-read";

/** 読む期間（これより古い持ち込みは好みの材料にしない） */
export const CUSTOMER_SENT_DAYS = 120;
const PAGE_MAX = 2;
const PAGE_BUDGET_MS = 3000;
/** ページを開くのは最近の URL だけ（古い掲載は終わっていることが多い＝待つだけ損） */
const PAGE_RECENT_DAYS = 30;

export function customerSentPortalFetchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.CUSTOMER_SENT_PORTAL_FETCH ?? "").trim().toLowerCase() !== "off";
}

export type CustomerSentLoad = { block: string | null; items: CustomerSentProperty[]; reason: string; stats?: Record<string, number> };

export async function loadCustomerSentPropertyBlock(sb: SupabaseClient, conversationId: string | null | undefined): Promise<CustomerSentLoad> {
  if (!customerSentPropertyEnabled()) return { block: null, items: [], reason: "off" };
  if (!conversationId) return { block: null, items: [], reason: "no_conversation" };
  try {
    const cut = await loadDeepseekCutoff(sb, conversationId);
    if (cutoffMs(cut) === null) return { block: null, items: [], reason: "post_apply_blocked" };
    const since = new Date(Date.now() - CUSTOMER_SENT_DAYS * 86400_000).toISOString();
    const [{ data: msgs, error }, { data: conv }] = await Promise.all([
      sb.from("messages").select("sender, text, image_type, created_at").eq("conversation_id", conversationId).eq("sender", "customer")
        .gte("created_at", since).order("created_at", { ascending: false }).limit(400),
      sb.from("conversations").select("customer_name").eq("id", conversationId).maybeSingle(),
    ]);
    if (error) return { block: null, items: [], reason: `read_failed:${error.message}` };
    type M = { sender: string; text: string | null; image_type: string | null; created_at: string };
    const rows = filterAfterCutoff(((msgs ?? []) as M[]).reverse(), (m) => m.created_at, cut);
    const name = (conv as { customer_name?: string | null } | null)?.customer_name ?? null;
    const pages = new Map<string, PortalPage>();
    if (customerSentPortalFetchEnabled()) {
      const recent = Date.now() - PAGE_RECENT_DAYS * 86400_000;
      const urls = [...new Set(rows.slice().reverse().filter((m) => Date.parse(m.created_at) >= recent).flatMap((m) => portalUrlsIn(m.text)))].slice(0, PAGE_MAX);
      const t0 = Date.now();
      for (const u of urls) {
        const left = PAGE_BUDGET_MS - (Date.now() - t0);
        if (left < 800) break;
        pages.set(u, await readPortalPage(u, { timeoutMs: Math.min(2500, left) }));
      }
    }
    const r = collectCustomerSentProperties(rows, { pages, mask: (s) => maskPII(s, [name]) });
    return { block: customerSentPropertyBlock(r.items), items: r.items, reason: r.items.length ? "ok" : "none", stats: { ...r.stats, pages: pages.size } };
  } catch (e) {
    return { block: null, items: [], reason: `error:${e instanceof Error ? e.message : String(e)}` };
  }
}
