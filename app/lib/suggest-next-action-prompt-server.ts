// app/lib/suggest-next-action-prompt-server.ts
// 次の一手の予想の固定の前置きの材料を DB から読む（route と温め prefix-warm が同じ関数を使う＝1文字もずれない）
import { supabase } from "./supabase";
import type { SuggestNextActionPrefixInputs } from "./suggest-next-action-prompt";
// 9巡目（10/08）: 学習ルールの見直しの重ね（テストの会話だけ・rules-overlay.ts）。重ねが無ければ今と同じ
import { currentRulesOverlay, applyRulesOverlay, overlayExtraLimit } from "./rules-overlay";

export async function loadSuggestNextActionPrefixInputs(): Promise<SuggestNextActionPrefixInputs> {
  const ov = currentRulesOverlay();
  const [{ data: aixLogicRows }, { data: flowGuideRow }, { data: boundaryRuleRows }] = await Promise.all([
    // UIで管理しているAIXロジック。2026-09-29: key 順（旧は ORDER BY なし＝並びの揺れで前置きの鍵が割れる余地）
    supabase.from("ai_prompts").select("key, content").like("key", "aix_logic_%").order("key", { ascending: true }),
    // aix_flow_guide（analyze-aix-flow cron の学習成果・毎日 09:00 UTC に書き直される）
    supabase.from("ai_prompts").select("content").eq("key", "aix_flow_guide").maybeSingle(),
    // f-3: 確定済み線引きルール（BOUNDARY-* / ai-feedback の aix_boundary 回答由来）。rule_key を第2キーに（同時刻更新の並びを固定）
    supabase.from("ai_prompt_rules").select("rule_key, action_type, rule_text").like("rule_key", "BOUNDARY-%").eq("is_active", true)
      .order("updated_at", { ascending: false, nullsFirst: false }).order("rule_key", { ascending: true }).limit(50 + overlayExtraLimit(ov)),
  ]);
  return {
    aixLogicRows: (aixLogicRows ?? []) as Array<{ key: string; content: string | null }>,
    boundaryRuleRows: (ov ? applyRulesOverlay((boundaryRuleRows ?? []) as Array<{ rule_key: string; action_type: string | null; rule_text: string | null }>, ov, 50) : (boundaryRuleRows ?? [])) as Array<{ rule_key: string; action_type: string | null; rule_text: string | null }>,
    aixFlowGuide: ((flowGuideRow?.content as string | undefined) ?? "").trim(),
  };
}
