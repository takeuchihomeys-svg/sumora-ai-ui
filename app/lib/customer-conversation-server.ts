// app/lib/customer-conversation-server.ts — お客様（property_customers）→ 送り先の会話を1つ選ぶ（DB を読む側）
//
// 2026-10-20 竹内さん（P1 f9d261d4・アカウントの取り違え）: 旧は「そのお客様に結んだ会話のうち updated_at が一番新しい物」。
//   同じ人がスモラとイエヤスにいると、話していないアカウントの会話が選ばれ、AIX ツールから物件がそちらに送られた（send-account.ts の根っこ①）。
//   → 「お客様が最後に話した会話」で選ぶ（判断は send-account.pickConversationForCustomer）。戻す: PICKUP_CONV_BY_CUSTOMER_MSG=off
import type { SupabaseClient } from "@supabase/supabase-js";
import { pickConversationForCustomer, pickConvByCustomerMsgEnabled, type CustomerConvLite, type CustomerConvPick } from "@/app/lib/send-account";

export async function primaryConversationForCustomer(sb: SupabaseClient, propertyCustomerId: string | null | undefined): Promise<CustomerConvPick> {
  if (!propertyCustomerId) return { id: null, ambiguous: false, accounts: [] };
  const { data, error } = await sb.from("conversations").select("id, account, updated_at")
    .eq("property_customer_id", propertyCustomerId).order("updated_at", { ascending: false }).limit(10);
  if (error) return { id: null, ambiguous: false, accounts: [] };
  const convs = ((data ?? []) as Array<{ id: string; account: string | null; updated_at: string | null }>).map((c) => ({ ...c, id: String(c.id) }));
  if (convs.length <= 1 || !pickConvByCustomerMsgEnabled(process.env)) {
    const pick = pickConversationForCustomer(convs.map((c) => ({ ...c, last_customer_at: null })));
    return pick;
  }
  const withLast: CustomerConvLite[] = await Promise.all(convs.map(async (c) => {
    const { data: m } = await sb.from("messages").select("created_at").eq("conversation_id", c.id).eq("sender", "customer")
      .order("created_at", { ascending: false }).limit(1);
    return { ...c, last_customer_at: ((m ?? [])[0] as { created_at?: string } | undefined)?.created_at ?? null };
  }));
  const pick = pickConversationForCustomer(withLast);
  if (pick.ambiguous) console.warn(JSON.stringify({ tag: "customer-conv:multi-account", pcid: propertyCustomerId.slice(0, 8), picked: pick.id?.slice(0, 8) ?? null, accounts: pick.accounts }));
  return pick;
}
