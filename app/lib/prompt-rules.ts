import { supabase } from "@/app/lib/supabase";

interface PromptRuleRow {
  rule_key: string;
  rule_text: string;
  condition_key: string | null;
  condition_value: string | null;
  priority: number;
  is_permanent?: boolean;
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
  includeGlobal = true, // false のとき globalフォールバック（action_type IS NULL）を除外する。
                        // final_check など「専用ルールのみ」を取りたい場合に使う。
                        // DB に専用ルールが0件なら空文字を返す（汚染なし）。
  includeLearnAix = false  // true のとき LEARN-AIX-* ルール（aix-weekly-learning / analyze-diffs が
                           // action_type=AIXアクション別に蓄積する編集差分学習ルール）を除外対象から外す。
                           // 旧世代の generate_reply 向け LEARN-*（廃止済み・数千件）は引き続き除外。
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
        // includeGlobal=true（デフォルト）: 専用ルール + global共通ルール（action_type IS NULL）
        // includeGlobal=false: 専用ルールのみ（global混入を防ぐ。final_check等で使用）
        if (includeGlobal) {
          q = q.or(`action_type.eq.${actionType},action_type.is.null`);
        } else {
          q = q.eq("action_type", actionType);
        }
      } else {
        q = q.is("action_type", null);
      }
      // LEARN-* 除外フィルタ（両クエリ共通のためここで適用）
      // includeLearnAix=true: LEARN-AIX-* のみ許可（PostgRESTのor構文はワイルドカードに * を使う）
      if (includeLearnAix) {
        q = q.or("rule_key.not.like.LEARN-*,rule_key.like.LEARN-AIX-*");
      } else {
        q = q.not("rule_key", "like", "LEARN-%");
      }
      return q;
    };

    // ── 2クエリを並列実行（Promise.all）──
    // [1] 永久ルール（is_permanent=true）: 通常の150件上限・priority閾値とは独立した別枠（上限80件）。
    // [2] FEEDBACK-* / IMPLEMENT-* 等（LEARN-*はPhase1で廃止済み・HUMAN-*はRAGへ完全移行）
    // ナレッジはfetchKnowledge()のpgvector RAGで届くため ai_prompt_rules への重複注入不要
    //
    // priority >= 4 のみ注入（decayを実際に機能させるための閾値）:
    // ai-feedback/route.ts の90日decayは古いFEEDBACK-*を priority=2 に demote するが、
    // 閾値なしで priority 降順 LIMIT 150 だと総件数が150未満の間は demote 済みルールも
    // 全件注入され続け、decayが no-op になる。priority 3以下は注入対象から外す。
    // （BOUNDARY-* は priority=9 かつ decay 対象外のため、この閾値の影響を受けない）
    const [permanentRes, highPrioRes] = await Promise.all([
      buildBaseQuery()
        .eq("is_permanent", true)
        .order("priority", { ascending: false })
        .order("updated_at", { ascending: false, nullsFirst: false })
        .limit(80)
        .abortSignal(AbortSignal.timeout(8_000)),
      buildBaseQuery()
        .eq("is_permanent", false)
        .gte("priority", 4)
        .order("priority", { ascending: false })
        .order("updated_at", { ascending: false, nullsFirst: false })
        .limit(150)
        .abortSignal(AbortSignal.timeout(8_000)),
    ]);

    if (highPrioRes.error || permanentRes.error) {
      // ③ DB障害時: サイレント消失を防ぐ。空文字ではなく警告テキストを返してAIに認知させる
      const err = highPrioRes.error ?? permanentRes.error;
      console.error("[fetchPromptRules] CRITICAL: DBクエリ失敗 — ルールが注入されません", err);
      return "\n\n【重要: ルールDBへの接続に失敗しました。基本的な敬語・正確な情報提供・謝罪禁止の原則を守って回答してください。】";
    }

    const permanentRows = (permanentRes.data ?? []) as PromptRuleRow[];
    const highPrio = (highPrioRes.data ?? []) as PromptRuleRow[];

    // 条件フィルタ（永久ルールにも条件は適用する）
    const filterRow = (r: PromptRuleRow): boolean => {
      if (!r.condition_key || r.condition_value === null) return true;
      const actual = conditions[r.condition_key];
      if (actual === undefined) {
        console.warn(`[fetchPromptRules] unknown condition_key "${r.condition_key}" in rule — rule skipped`);
        return false;
      }
      if (actual === null) return false;
      return String(actual) === r.condition_value;
    };

    const permanentApplicable = permanentRows.filter(filterRow);
    const applicable = highPrio.filter(filterRow);

    // rule_textで重複排除（priority降順ソート済みなので最初の出現を残す）
    const seen = new Set<string>();
    const deduped = applicable.filter(r => {
      if (seen.has(r.rule_text)) return false;
      seen.add(r.rule_text);
      return true;
    });

    if (!deduped.length && !permanentApplicable.length) return "";

    const sections: string[] = [];

    // ── 永久ルール（卒業済み・絶対に漏れない）──
    // BOUNDARY-* ルールは【線引き】プレフィックスを付けて final-check が AIX_BOUNDARY_DB として識別できるようにする
    if (permanentApplicable.length > 0) {
      const permanentLines = permanentApplicable.map(r => {
        const prefix = r.rule_key.startsWith("BOUNDARY-") ? "【線引き】" : "";
        return `・${prefix}${r.rule_text}`;
      }).join("\n");
      sections.push(`【永久ルール（最上位・絶対厳守）】\n${permanentLines}`);
    }

    // FEEDBACK-* / IMPLEMENT-* 等を priority 降順で注入
    // HUMAN-* は is_active=false（RAGへ完全移行済み）のためここには現れない
    if (deduped.length > 0) {
      const otherLines = deduped.map(r => {
        const prefix = r.rule_key.startsWith("BOUNDARY-") ? "【線引き】" : "";
        return `・${prefix}${r.rule_text}`;
      }).join("\n");
      sections.push(`【AI学習ルール（参考）】\n${otherLines}`);
    }
    return "\n\n" + sections.join("\n\n");
  } catch (error) {
    console.error("[fetchPromptRules] CRITICAL: 予期しないエラー — ルールが注入されません", error);
    return "\n\n【重要: ルールシステムエラーが発生しました。基本的な敬語・正確な情報提供・謝罪禁止の原則を守って回答してください。】";
  }
}
