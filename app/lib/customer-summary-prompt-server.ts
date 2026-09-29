// app/lib/customer-summary-prompt-server.ts
// お客様の要約の固定の前置きの材料を DB から読む（route と温め prefix-warm が同じ関数を使う＝1文字もずれない）
import { supabase } from "./supabase";
import { CUSTOMER_SUMMARY_SYSTEM } from "./customer-summary-prompt";

export type CustomerSummaryPrefixInputs = { systemPrompt: string; nextActionRuleContents: string[] };

export async function loadCustomerSummaryPrefixInputs(): Promise<CustomerSummaryPrefixInputs> {
  const [promptRes, rulesRes] = await Promise.all([
    // プロンプト管理UIで上書き可能（なければコード定数をフォールバック）
    supabase.from("ai_prompts").select("content").eq("key", "customer_summary_system").maybeSingle(),
    // 次アクションルール: log-aix-usage が category="pattern" + title="next_action_rule_..." で保存
    // （CHECK制約により旧 category="next_action_pattern" は存在しない）
    // 2026-09-29: 同点の並びで前置きの鍵が揺れないよう id を第2キーに（内容は同じ8件）
    supabase.from("ai_reply_knowledge").select("content").eq("category", "pattern").ilike("title", "next_action_rule_%")
      .neq("hypothesis_status", "rejected").order("apply_count", { ascending: false }).order("id", { ascending: true }).limit(8),
  ]);
  const systemPrompt = (promptRes.data?.content as string | null | undefined) ?? CUSTOMER_SUMMARY_SYSTEM;
  const nextActionRuleContents = ((rulesRes.data ?? []) as Array<{ content: string | null }>).map((r) => r.content ?? "");
  return { systemPrompt, nextActionRuleContents };
}
