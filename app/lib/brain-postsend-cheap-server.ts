// app/lib/brain-postsend-cheap-server.ts — 約束の送信の直後、ブレイン（Sonnet）の代わりに決まった計算で要対応を立てる（BRAIN_POSTSEND_CHEAP=on の時だけ）
//   判断は brain-postsend-cheap.decidePostSendCheap（試算 scripts/audit-brain-postsend-value.ts と同じ関数）。
//   true = 安い道で済ませた（ブレインを呼ばない）／false = 今まで通りブレインを呼ぶ
import { supabase } from "@/app/lib/supabase-server";
import { promisesInStaffText } from "@/app/lib/promise-queue";
import { MAIN_AIX_ITEM_OR } from "@/app/lib/viewing-day-greeting";
import { brainPostSendCheapEnabled, customerPointedPropertyText, customerTurnBefore, decidePostSendCheap, propertyInPlayFrom } from "@/app/lib/brain-postsend-cheap";

const WINDOW_MS = 8 * 86_400_000;

export async function tryPostSendCheap(conversationId: string, sentText: string, sentAtIso: string = new Date().toISOString()): Promise<boolean> {
  if (!brainPostSendCheapEnabled()) return false;
  const nowMs = Date.now();
  const sentSteps = promisesInStaffText(sentText, sentAtIso);
  if (!sentSteps.length) return false;
  const since = new Date(nowMs - WINDOW_MS).toISOString();
  const [{ data: conv }, { data: msgs, error: mErr }, { count: propCount, error: lErr }, { data: open, error: oErr }] = await Promise.all([
    supabase.from("conversations").select("customer_name, is_post_apply").eq("id", conversationId).maybeSingle(),
    supabase.from("messages").select("sender, text, created_at").eq("conversation_id", conversationId).gte("created_at", since).order("created_at", { ascending: false }).limit(400),
    supabase.from("aix_usage_logs").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId).in("aix_type", ["property_send", "property_recommendation", "estimate_sheet"]),
    supabase.from("aix_action_items").select("action").eq("conversation_id", conversationId).eq("status", "pending").or(MAIN_AIX_ITEM_OR).limit(1),
  ]);
  if (!conv || mErr || lErr || oErr) return false; // 読めない時はブレインへ
  const rows = ((msgs ?? []) as Array<{ sender: string; text: string | null; created_at: string }>).slice().reverse().map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at }));
  const sentAtMs = Date.parse(sentAtIso);
  const d = decidePostSendCheap({
    sentSteps, nowMs, need: null,
    openItemAction: ((open ?? []) as Array<{ action: string }>)[0]?.action ?? null,
    isPostApply: !!conv.is_post_apply,
    propertyInPlay: propertyInPlayFrom(rows, (propCount ?? 0) > 0),
    customerPointedProperty: customerPointedPropertyText(customerTurnBefore(rows, Number.isFinite(sentAtMs) ? sentAtMs : nowMs)),
  });
  console.log(JSON.stringify({ tag: "brain:postsend-cheap", conversationId, decision: d.kind, reason: d.kind === "insert" ? d.step.kind : d.reason, action: d.kind === "insert" ? d.step.action : null }));
  if (d.kind === "full") return false;
  if (d.kind === "skip") return true;
  const lastCustomer = [...rows].reverse().find((m) => m.sender === "customer");
  // ブレインの約束の判断（brain-core の promise:*）と同じ形の判断を、ブレインと同じ書き口に渡す（同じ指示の再通知なし・48時間超の古い番は登録しない・返信で済みの判定もそのまま）
  const meta = {
    action: d.step.action, check_pattern: d.step.checkPattern, reply_mode: "aix", source: "postsend_cheap",
    decision_source: `promise:${d.step.kind}`, analyzed_msg_ts: lastCustomer?.createdAt ?? null,
  };
  const customerName = (conv.customer_name as string | null) ?? "";
  const { syncAixActionItem } = await import("@/app/lib/aix-action-items");
  await syncAixActionItem({ conversationId, customerName, meta });
  const { syncBrainFollowups } = await import("@/app/lib/brain-attention-server");
  await syncBrainFollowups(conversationId, meta, customerName);
  return true;
}
