// app/lib/estimate-handoff-server.ts
// LINE の会話 → 見積書作成の引き継ぎ（材料を DB から読む・LLM は呼ばない・書かない）。判断は estimate-handoff.ts（純関数）。
//
// 2026-10-01 竹内「見積書きかれたら…押したら見積書のツールに連携・送った物件がセットされた状態で・AD も分かるように・
//   見積書の画面にも監視する部分配置」
//   返す物: ①見積書のお部屋（出所つき）と資料・家賃・AD ②割引の目安 ③見張りの板（お客様・今の段階・最近の発言・送った物・ブレインの判断・警告）
import { supabase } from "@/app/lib/supabase";
import { getCustomerState, loadCustomerStateInput } from "@/app/lib/customer-state-server";
import { resolveCustomerState, type CustomerState } from "@/app/lib/customer-state";
import { customerSharedPropertyNames } from "@/app/lib/customer-property-names";
import { pickupDealStatus } from "@/app/lib/listing-deal-status";
import { listingAdStamp, adMonthsOfStamp } from "@/app/lib/pickup-listing-text";
import { isCustomerDelivery } from "@/app/lib/property-brain";
import {
  selectEstimateTarget, suggestEstimateDiscount, wantsLowInitialCostText, rentFromSummary, resolveEstimateEntry,
  buildHandoffEvents, customerAskTimes, type HandoffSentProperty, type HandoffPickup, type HandoffAdRow, type HandoffMessage, type HandoffFocus,
  type EstimateHandoff, type EstimateHandoffAccount,
} from "@/app/lib/estimate-handoff";
export type { EstimateHandoff } from "@/app/lib/estimate-handoff";

const DAYS = 60;

type MsgRow = { sender: string; text: string | null; image_url: string | null; image_type: string | null; created_at: string; is_aix_generated: boolean | null; line_message_id: string | null; quoted_message_id: string | null };

const AIX_LABEL: Record<string, string> = {
  property_send: "物件ピックアップ", property_recommendation: "物件オススメ", property_check_result: "物件確認した",
  estimate_sheet: "見積書送る", viewing_invite: "内覧へ", meeting_place: "待ち合わせ", application_push: "申込へ",
};

/** 監査用: その時点（asOf）までの記録だけで決め直す（見積書を送った時に、今の選び方なら同じお部屋を選んだか） */
async function customerStateAsOf(conversationId: string, asOf: string): Promise<CustomerState | null> {
  const input = await loadCustomerStateInput(conversationId, { now: new Date(asOf).getTime() });
  if (!input) return null;
  const le = (x: string | null | undefined) => !x || x <= asOf;
  return resolveCustomerState({
    ...input,
    messages: input.messages.filter((m) => m.createdAt <= asOf),
    aixRows: input.aixRows.filter((r) => le(r.sent_at ?? r.created_at)),
    recordedFacts: input.recordedFacts.filter((f) => f.sent_at <= asOf),
    lineTasks: (input.lineTasks ?? []).filter((t) => le(t.created_at)),
    viewingHistory: input.viewingHistory.filter((v) => le(v.created_at)),
    sentProperties: input.sentProperties.filter((r) => le(r.sent_at)),
    ledger: null,
  });
}

/**
 * @param opts.asOf 監査用（その時刻より前の記録だけで決める）。画面からは渡さない
 */
export async function loadEstimateHandoff(conversationId: string, opts: { asOf?: string } = {}): Promise<EstimateHandoff | null> {
  const asOf = opts.asOf ?? null;
  const { data: conv } = await supabase.from("conversations")
    .select("id, customer_name, account, property_customer_id, suggested_aix_meta")
    .eq("id", conversationId).maybeSingle();
  if (!conv) return null;
  const c = conv as { id: string; customer_name: string | null; account: string | null; property_customer_id: string | null; suggested_aix_meta: Record<string, unknown> | null };
  const pcId = c.property_customer_id;
  const since = new Date((asOf ? new Date(asOf).getTime() : Date.now()) - DAYS * 86400e3).toISOString();

  const [msgsRes, custRes, sentRes, pickRes, estRes, aixRes, state] = await Promise.all([
    supabase.from("messages").select("sender, text, image_url, image_type, created_at, is_aix_generated, line_message_id, quoted_message_id")
      .eq("conversation_id", conversationId).lte("created_at", asOf ?? "9999-12-31").order("created_at", { ascending: false }).limit(150),
    pcId ? supabase.from("property_customers").select("customer_name, ai_summary, initial_cost_limit, preferences, other_requests, raw_format_text, move_in_time").eq("id", pcId).maybeSingle() : Promise.resolve({ data: null }),
    (() => {
      const q = supabase.from("sent_properties").select("property_name, room_no, image_url, source, delivery, sent_at, pickup_id, rent, ad_months, ad_yen")
        .gte("sent_at", since).lt("sent_at", asOf ?? "9999-12-31").order("sent_at", { ascending: false }).limit(1500);
      return pcId ? q.eq("property_customer_id", pcId) : q.eq("conversation_id", conversationId);
    })(),
    (() => {
      const q = supabase.from("property_pickups").select("id, property_name, room_no, sent_at, created_at, status, ad_yen, summary_text, page_image_url, pdf_text, terms, expired_at")
        .gte("created_at", since).lt("created_at", asOf ?? "9999-12-31").order("created_at", { ascending: false }).limit(300);
      return pcId ? q.eq("property_customer_id", pcId) : q.eq("conversation_id", conversationId);
    })(),
    (() => {
      const q = supabase.from("estimate_records").select("discount_yen, estimated_at").lt("estimated_at", asOf ?? "9999-12-31").order("estimated_at", { ascending: false }).limit(20);
      return pcId ? q.eq("property_customer_id", pcId) : q.eq("conversation_id", conversationId);
    })(),
    supabase.from("aix_usage_logs").select("aix_type, created_at, property_names, generated_text").eq("conversation_id", conversationId).lt("created_at", asOf ?? "9999-12-31")
      .order("created_at", { ascending: false }).limit(8),
    asOf ? customerStateAsOf(conversationId, asOf) : getCustomerState(conversationId),
  ]);

  const msgs = ((msgsRes.data ?? []) as MsgRow[]).slice().reverse(); // 古い順
  const cust = (custRes as { data: Record<string, unknown> | null }).data as {
    customer_name?: string | null; ai_summary?: string | null; initial_cost_limit?: number | null; preferences?: string | null;
    other_requests?: string | null; raw_format_text?: string | null; move_in_time?: string | null;
  } | null;

  type SentRow = { property_name: string | null; room_no: string | null; image_url: string | null; source: string | null; delivery: string | null; sent_at: string; pickup_id: number | null; rent: number | null; ad_months: number | null; ad_yen: number | null };
  const sentRows = (sentRes.data ?? []) as SentRow[];
  const sent: HandoffSentProperty[] = sentRows
    .filter((r) => r.property_name && isCustomerDelivery(r) && r.source !== "aix:estimate_sheet")
    .map((r) => ({ name: r.property_name!, room: r.room_no, sentAt: r.sent_at, source: r.source, imageUrl: r.image_url, pickupId: r.pickup_id }));
  const adRows: HandoffAdRow[] = sentRows.filter((r) => r.property_name && (r.ad_months != null || r.ad_yen != null))
    .map((r) => ({ name: r.property_name!, room: r.room_no, adMonths: r.ad_months, adYen: r.ad_yen, rent: r.rent, at: r.sent_at }));

  type PickRow = { id: number; property_name: string; room_no: string | null; sent_at: string | null; created_at: string; status: string | null; ad_yen: number | null; summary_text: string | null; page_image_url: string | null; pdf_text: string | null; terms: { evidence?: { moveIn?: string | null } | null } | null; expired_at: string | null };
  const pickups: HandoffPickup[] = ((pickRes.data ?? []) as PickRow[]).map((p) => {
    const { rent, managementFee } = rentFromSummary(p.summary_text);
    const stamp = listingAdStamp(p.pdf_text);
    const adMonths = adMonthsOfStamp(stamp, rent) ?? (p.ad_yen && rent ? Math.round((p.ad_yen / rent) * 100) / 100 : null);
    return {
      id: p.id, name: p.property_name, room: p.room_no, sentAt: p.sent_at, createdAt: p.created_at, status: p.status,
      adYen: p.ad_yen, rent, managementFee, adStamp: stamp, adMonths,
      dealStatus: pickupDealStatus(p), pageImageUrl: p.page_image_url, pdfText: p.pdf_text, expired: !!p.expired_at,
    };
  });

  const focusRoom = state?.focusKey ? state.properties.find((p) => p.key === state.focusKey) ?? null : null;
  const focus: HandoffFocus = focusRoom ? {
    name: focusRoom.name, building: focusRoom.building, room: focusRoom.room, sentByUs: focusRoom.sentByUs,
    status: focusRoom.status, statusLabel: focusRoom.statusLabel, customerInterest: focusRoom.customerInterest,
  } : null;

  const hMsgs: HandoffMessage[] = msgs.map((m) => ({ sender: m.sender, text: m.text, at: m.created_at, imageUrl: m.image_url, imageType: m.image_type, lineMessageId: m.line_message_id, quotedId: m.quoted_message_id }));
  const events = buildHandoffEvents({
    messages: hMsgs, sent,
    sharedNamesOf: (m) => customerSharedPropertyNames([{ sender: m.sender, text: m.text, createdAt: m.at }], { limit: 3 }).map((x) => x.name),
  });
  const choice = selectEstimateTarget({ events, focus, sent, pickups, adRows, now: asOf ? new Date(asOf).getTime() : Date.now(), askTimes: customerAskTimes(hMsgs) });
  const pastDiscounts = ((estRes.data ?? []) as Array<{ discount_yen: number | null }>).map((r) => r.discount_yen ?? 0).filter((v) => v > 0);
  const t = choice.target;
  const discount = t ? suggestEstimateDiscount({ rent: t.rent, adYen: t.adYen, pastDiscounts }) : null;

  const lowInitialCost = (cust?.initial_cost_limit ?? 0) > 0
    || wantsLowInitialCostText(`${cust?.preferences ?? ""} ${cust?.other_requests ?? ""} ${cust?.raw_format_text ?? ""}`)
    || msgs.some((m) => m.sender === "customer" && wantsLowInitialCostText(m.text));
  const meta = c.suggested_aix_meta as { action?: string; note?: string; reply_direction_label?: string; decision_source?: string } | null;
  const account: EstimateHandoffAccount = c.account === "ieyasu" || c.account === "giga" ? c.account : "sumora";

  return {
    conversationId,
    customerName: (c.customer_name ?? cust?.customer_name ?? "").trim(),
    account,
    choice,
    discount,
    pastDiscounts,
    watch: {
      headline: state?.headline ?? null,
      stageLabel: state?.stageLabel ?? null,
      summary: cust?.ai_summary ? String(cust.ai_summary).slice(0, 400) : null,
      lowInitialCost,
      moveIn: cust?.move_in_time ?? null,
      latestCustomer: msgs.filter((m) => m.sender === "customer" && (m.text || m.image_url)).slice(-5)
        .map((m) => ({ at: m.created_at, text: m.text ? m.text.slice(0, 160) : `[画像${m.image_type ? `・${m.image_type}` : ""}]` })),
      sent: ((aixRes.data ?? []) as Array<{ aix_type: string; created_at: string; property_names: string[] | null; generated_text: string | null }>).slice(0, 6)
        .map((r) => ({ at: r.created_at, label: `${AIX_LABEL[r.aix_type] ?? r.aix_type}${r.property_names?.length ? `（${r.property_names.slice(0, 3).join("・")}）` : ""}` })),
      brain: meta ? { action: meta.action ?? null, note: meta.note ?? null, replyDirection: meta.reply_direction_label ?? null, decisionSource: meta.decision_source ?? null } : null,
      entry: resolveEstimateEntry({ brainAction: meta?.action ?? null, lowInitialCost }),
      conflicts: (state?.conflicts ?? []).filter((x) => x.severity === "warn").map((x) => x.detail).slice(0, 3),
    },
  };
}
