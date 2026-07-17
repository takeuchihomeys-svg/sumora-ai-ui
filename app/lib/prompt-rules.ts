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
  conditions: Record<string, string | boolean | null | undefined> = {},
  excludeLearnRules = false,
  onLearnIds?: (ids: string[]) => void
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

    const [highPrioRes, learnRes] = await Promise.all([
      // HUMAN-* / FEEDBACK-* / IMPLEMENT-* 等（LEARN-*はPhase1で廃止済み）
      buildBaseQuery()
        .not("rule_key", "like", "LEARN-%")
        .order("priority", { ascending: false })
        .order("updated_at", { ascending: false, nullsFirst: false })
        .limit(150),
      // LEARN-*廃止（Phase1）: DBでis_active=false済み・クエリも常に空配列を返す
      // ナレッジはfetchKnowledge()のpgvector RAGで届くため二重注入不要
      Promise.resolve({ data: [] as PromptRuleRow[], error: null }),
    ]);

    if (highPrioRes.error) console.error("[fetchPromptRules] high-prio query", highPrioRes.error);
    if (learnRes.error) console.error("[fetchPromptRules] learn query", learnRes.error);
    if (highPrioRes.error && learnRes.error) return "";

    const highPrio = (highPrioRes.data ?? []) as PromptRuleRow[];
    const learn = (learnRes.data ?? []) as PromptRuleRow[];

    // priority 降順・rule_key 重複除去で結合
    const seen = new Set<string>();
    const merged: PromptRuleRow[] = [];
    for (const r of [...highPrio, ...learn]) {
      if (seen.has(r.rule_key)) continue;
      seen.add(r.rule_key);
      merged.push(r);
    }
    merged.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    if (!merged.length) return "";

    const applicable = merged.filter(r => {
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

    // LEARN ルール適用追跡: knowledge_apply_log へのコールバック（generate-reply 経由のみ使用）
    if (onLearnIds) {
      const learnIds = applicable
        .filter(r => r.rule_key.startsWith("LEARN-"))
        .map(r => r.rule_key.slice(6))   // "LEARN-{uuid}" → uuid
        .filter(Boolean);
      if (learnIds.length > 0) onLearnIds(learnIds);
    }

    const ruleLines = applicable.map(r => `・${r.rule_text}`).join("\n");
    return `\n\n【管理者追加ルール（最優先 — 以下を必ず守ること）】\n${ruleLines}`;
  } catch (error) {
    console.error("[fetchPromptRules]", error);
    return "";
  }
}
