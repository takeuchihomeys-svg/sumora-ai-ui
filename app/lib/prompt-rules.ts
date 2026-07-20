import { supabase } from "@/app/lib/supabase";

interface PromptRuleRow {
  rule_key: string;
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
    // ── 枠取り方式 ──
    // LEARN-* が数千件あり、単一クエリ LIMIT 100 だと priority=8 の LEARN-* が枠を埋め尽くして
    // HUMAN-*(priority=10) / FEEDBACK-*(priority=8) / IMPLEMENT-*(priority=7) が届かなくなる。
    // → 非LEARN上位70件 + LEARN上位60件を別枠で取得してから priority 降順で結合する。
    const buildBaseQuery = () => {
      let q = supabase
        .from("ai_prompt_rules")
        .select("rule_key, rule_text, condition_key, condition_value, priority")
        .eq("is_active", true);
      if (actionType) {
        q = q.or(`action_type.eq.${actionType},action_type.is.null`);
      } else {
        q = q.is("action_type", null);
      }
      return q;
    };

    // HUMAN-* / FEEDBACK-* / IMPLEMENT-* 等（LEARN-*はPhase1で廃止済み）
    // ナレッジはfetchKnowledge()のpgvector RAGで届くため二重注入不要
    const highPrioRes = await buildBaseQuery()
      .not("rule_key", "like", "LEARN-%")
      .order("priority", { ascending: false })
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(150);

    if (highPrioRes.error) {
      // ③ DB障害時: サイレント消失を防ぐ。空文字ではなく警告テキストを返してAIに認知させる
      console.error("[fetchPromptRules] CRITICAL: DBクエリ失敗 — ルールが注入されません", highPrioRes.error);
      return "\n\n【重要: ルールDBへの接続に失敗しました。基本的な敬語・正確な情報提供・謝罪禁止の原則を守って回答してください。】";
    }

    const highPrio = (highPrioRes.data ?? []) as PromptRuleRow[];

    const applicable = highPrio.filter(r => {
      if (!r.condition_key || r.condition_value === null) return true;
      const actual = conditions[r.condition_key];
      if (actual === undefined) {
        console.warn(`[fetchPromptRules] unknown condition_key "${r.condition_key}" in rule — rule skipped`);
        return false;
      }
      if (actual === null) return false;
      return String(actual) === r.condition_value;
    });

    if (!applicable.length) return "";

    // ① HUMAN-*（竹内さん確認済み・priority=10）を専用セクションに分離して最優先で注入
    // FEEDBACK-*/WEEKLY-*/DIFF-POLICY-* と同列に並べると末尾に埋もれてLLMに無視されるリスクがある
    const humanRules = applicable.filter(r => r.rule_key.startsWith("HUMAN-")).slice(0, 30);
    const otherRules = applicable.filter(r => !r.rule_key.startsWith("HUMAN-"));

    const sections: string[] = [];
    if (humanRules.length > 0) {
      const humanLines = humanRules.map(r => `・${r.rule_text}`).join("\n");
      sections.push(`【確認済み運用ルール（最優先・必ず守ること）】\n${humanLines}`);
    }
    if (otherRules.length > 0) {
      const otherLines = otherRules.map(r => `・${r.rule_text}`).join("\n");
      sections.push(`【AI学習ルール（参考）】\n${otherLines}`);
    }
    return "\n\n" + sections.join("\n\n");
  } catch (error) {
    console.error("[fetchPromptRules] CRITICAL: 予期しないエラー — ルールが注入されません", error);
    return "\n\n【重要: ルールシステムエラーが発生しました。基本的な敬語・正確な情報提供・謝罪禁止の原則を守って回答してください。】";
  }
}
