// app/lib/customer-summary-prompt-server.ts
// お客様の要約の固定の前置きの材料を DB から読む（route と温め prefix-warm が同じ関数を使う＝1文字もずれない）
import { supabase } from "./supabase-server";
import { CUSTOMER_SUMMARY_SYSTEM } from "./customer-summary-prompt";

export type CustomerSummaryPrefixInputs = { systemPrompt: string; nextActionRuleContents: string[] };

export async function loadCustomerSummaryPrefixInputs(): Promise<CustomerSummaryPrefixInputs> {
  const [promptRes, rulesRes] = await Promise.all([
    // プロンプト管理UIで上書き可能（なければコード定数をフォールバック）
    supabase.from("ai_prompts").select("content").eq("key", "customer_summary_system").maybeSingle(),
    // 次アクションルール: log-aix-usage が category="pattern" + title="next_action_rule_..." で保存
    // （CHECK制約により旧 category="next_action_pattern" は存在しない）
    // 2026-09-29: 同点の並びで前置きの鍵が揺れないよう id を第2キーに（内容は同じ8件）
    // 2026-11-14 作業員F: ilike → like（題は log-aix-usage が小文字の "next_action_rule_" で作る＝本番 871行で ilike と like は同じ件数・上位8件も同じ id を確かめた）。
    //   ilike は索引が効かず category=pattern の 8,880行を毎回読んでいた（平均 3.2秒・最長 8秒で時間切れ）。like は idx_ai_reply_knowledge_title_pattern が効く
    supabase.from("ai_reply_knowledge").select("content").eq("category", "pattern").like("title", "next_action_rule_%")
      .neq("hypothesis_status", "rejected").order("apply_count", { ascending: false }).order("id", { ascending: true }).limit(8),
  ]);
  const systemPrompt = (promptRes.data?.content as string | null | undefined) ?? CUSTOMER_SUMMARY_SYSTEM;
  const nextActionRuleContents = ((rulesRes.data ?? []) as Array<{ content: string | null }>).map((r) => r.content ?? "");
  return { systemPrompt, nextActionRuleContents };
}
