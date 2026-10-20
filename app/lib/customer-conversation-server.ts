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

/**
 * 2026-10-20 竹内さん（決定 e06c795a ⑤ トーク一覧の『新着 N件』の印のアカウントのずれ）: 多くのお客様をまとめて会話に結ぶ形。
 *   旧（property-pickups/talk の counts）は「お客様に結んだ会話のうち最初に見つかった物」に印を付けていて、
 *   同じ人がスモラとイエヤスにいると、話していないアカウントの会話に印が付く事があった。
 *   → primaryConversationForCustomer と同じ決まり（お客様が最後に話した会話・pickConversationForCustomer）で1人ずつ選ぶ。
 *   会話が1つのお客様は DB をそれ以上読まない（2つ以上の時だけ、その会話ごとにお客様の最後の発言の時刻を読む）。戻す: PICKUP_CONV_BY_CUSTOMER_MSG=off
 */
export async function primaryConversationsForCustomers(sb: SupabaseClient, propertyCustomerIds: ReadonlyArray<string | null | undefined>): Promise<Map<string, CustomerConvPick>> {
  const ids = [...new Set(propertyCustomerIds.filter((x): x is string => !!x))];
  const out = new Map<string, CustomerConvPick>();
  if (!ids.length) return out;
  const byPc = new Map<string, Array<{ id: string; account: string | null; updated_at: string | null }>>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("conversations").select("id, account, updated_at, property_customer_id").in("property_customer_id", ids.slice(i, i + 200));
    if (error) continue;
    for (const c of (data ?? []) as Array<{ id: string; account: string | null; updated_at: string | null; property_customer_id: string }>) {
      const arr = byPc.get(c.property_customer_id) ?? [];
      arr.push({ id: String(c.id), account: c.account, updated_at: c.updated_at });
      byPc.set(c.property_customer_id, arr);
    }
  }
  const useMsg = pickConvByCustomerMsgEnabled(process.env);
  await Promise.all([...byPc.entries()].map(async ([pc, convs]) => {
    if (convs.length <= 1 || !useMsg) { out.set(pc, pickConversationForCustomer(convs.map((c) => ({ ...c, last_customer_at: null })))); return; }
    const withLast: CustomerConvLite[] = await Promise.all(convs.map(async (c) => {
      const { data: m } = await sb.from("messages").select("created_at").eq("conversation_id", c.id).eq("sender", "customer")
        .order("created_at", { ascending: false }).limit(1);
      return { ...c, last_customer_at: ((m ?? [])[0] as { created_at?: string } | undefined)?.created_at ?? null };
    }));
    out.set(pc, pickConversationForCustomer(withLast));
  }));
  return out;
}
