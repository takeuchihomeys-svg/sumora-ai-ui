import { supabase } from "@/app/lib/supabase";

interface PromptRuleRow {
  rule_text: string;
  condition_key: string | null;
  condition_value: string | null;
  priority: number;
}

/**
 * ai_prompt_rules テーブルから適用可能なルールを取得し、プロンプト注入用文字列を返す
 * DB取得失敗はサイレントに "" を返してメイン処理を止めない。
 *
 * @param actionType アクション種別 ('application_push'/'viewing_invite'/'generate_reply'/null=globalのみ)
 * @param conditions 現在の条件マップ (例: { has_estimate: 'true', app_sub_mode: 'push' })
 */
export async function fetchPromptRules(
  actionType: string | null,
  conditions: Record<string, string | boolean | null | undefined> = {}
): Promise<string> {
  try {
    let query = supabase
      .from("ai_prompt_rules")
      .select("rule_text, condition_key, condition_value, priority")
      .eq("is_active", true)
      .order("priority", { ascending: false });

    if (actionType) {
      query = query.or(`action_type.eq.${actionType},action_type.is.null`);
    } else {
      query = query.is("action_type", null);
    }

    const { data: rules, error } = await query;
    if (error) {
      console.error("[fetchPromptRules]", error);
      return "";
    }
    if (!rules?.length) return "";

    const applicable = (rules as PromptRuleRow[]).filter(r => {
      if (!r.condition_key || r.condition_value === null) return true;
      const actual = conditions[r.condition_key];
      if (actual === undefined || actual === null) return false;
      return String(actual) === r.condition_value;
    });

    if (!applicable.length) return "";

    const ruleLines = applicable.map(r => `・${r.rule_text}`).join("\n");
    return `\n\n【管理者追加ルール（最優先 — 以下を必ず守ること）】\n${ruleLines}`;
  } catch (error) {
    console.error("[fetchPromptRules]", error);
    return "";
  }
}
