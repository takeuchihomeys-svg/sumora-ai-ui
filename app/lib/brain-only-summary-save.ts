// ブレインの戦略の層（と全体の分析）がお客様の要約を保存する1か所（2026-10-13・純関数は brain-only-summary.ts）
//   前の JSON の our_actions・inspection・estimate を残す／予測の記録（next_action_logs・winning_pattern_logs）を書く（旧は /api/customer-summary が書いていた）
//   BRAIN_ONLY_SUMMARY=off の時は旧と同じ（JSON をそのまま上書き・予測の記録は書かない＝要約の route が書く）
import { supabase } from "@/app/lib/supabase";
import { isTestConversation } from "@/app/lib/test-conversations";
import { brainOnlySummaryEnabled, mergeStrategySummaryJson, summaryPredictionRows } from "@/app/lib/brain-only-summary";

export async function saveBrainSummary(i: {
  propertyCustomerId: string;
  conversationId: string | null;
  summaryText: string | null;
  summaryJson: unknown;
  nowIso?: string;
}): Promise<void> {
  const on = brainOnlySummaryEnabled();
  let json: Record<string, unknown> | null = i.summaryJson && typeof i.summaryJson === "object" ? (i.summaryJson as Record<string, unknown>) : null;
  if (!i.summaryText && !json) return;
  if (on && json) {
    const { data: cur } = await supabase.from("property_customers").select("ai_summary_json").eq("id", i.propertyCustomerId).maybeSingle();
    json = mergeStrategySummaryJson((cur as { ai_summary_json?: unknown } | null)?.ai_summary_json ?? null, json);
  }
  const { error } = await supabase.from("property_customers").update({
    ...(i.summaryText ? { ai_summary: i.summaryText } : {}),
    ...(json ? { ai_summary_json: json } : {}),
    ai_summary_at: i.nowIso ?? new Date().toISOString(),
  }).eq("id", i.propertyCustomerId);
  if (error) { console.warn("[brain-summary] save failed:", i.propertyCustomerId, error.message); return; }
  if (!on) return;
  const rows = summaryPredictionRows({
    customerId: i.propertyCustomerId, conversationId: i.conversationId, summaryJson: json,
    isTest: isTestConversation(i.conversationId),
  });
  await Promise.all([
    rows.nextAction ? supabase.from("next_action_logs").insert(rows.nextAction).then(() => {}, () => {}) : null,
    rows.winningPattern ? supabase.from("winning_pattern_logs").insert(rows.winningPattern).then(() => {}, () => {}) : null,
  ]);
}
