import { supabase } from "@/app/lib/supabase";

// confirmed ナレッジの conversation_state → ai_prompt_rules の action_type マップ
// AIX固有ステート → AIXのaction_type（scoped注入）
// generate-reply 汎用ステート → "generate_reply"（generate-replyのみに注入）
// 未知ステート / null → null（全アクションに注入するグローバル）
const KNOWLEDGE_STATE_TO_ACTION: Record<string, string | null> = {
  // AIX アクション固有ステート
  property_send: "property_send", property_send_pickup: "property_send",
  viewing_invite: "viewing_invite", viewing: "viewing_invite",
  viewing_schedule: "viewing_invite", inspection: "viewing_invite",
  greeting_viewing: "greeting_viewing",
  application_push: "application_push", applying: "application_push",
  application: "application_push", screening: "application_push", contract: "application_push",
  condition_hearing: "condition_hearing",
  estimate_sheet: "estimate_sheet", estimate_request: "estimate_sheet",
  meeting_place: "meeting_place",
  property_check_result: "property_check_result",
  property_check_result_available: "property_check_result",
  property_check_result_unavailable: "property_check_result",
  property_check_result_alternative: "property_check_result",
  property_check_result_vacate_date: "property_check_result",
  property_check_result_mgmt_guarantor: "property_check_result",
  property_check_result_mgmt_move_in: "property_check_result",
  property_check_result_mgmt_initial_cost: "property_check_result",
  property_check_result_mgmt_parking: "property_check_result",
  property_check_result_mgmt_pet: "property_check_result",
  property_recommendation: "property_recommendation",
  // サブステート（STATE_LEARNABLE に存在するが旧版で未定義だったエントリ）
  application_push_push: "application_push",
  application_push_confirm: "application_push",
  application_push_docs_request: "application_push",
  property_send_new_arrival: "property_send",
  property_send_widen: "property_send",
  // generate-reply 汎用ステート
  hearing: "generate_reply", first_reply: "generate_reply",
  proposing: "generate_reply", closed_won: "generate_reply",
  // 未知ステート → null（グローバル）
};

export type KnowledgeRow = {
  id: string;
  title: string;
  content: string;
  conversation_state: string | null;
  importance: number;
};

// confirmed になった知識を ai_prompt_rules に即時同期
// importance >= 7 のもののみ対象（analyze-diffs の >= 8 より緩和）
export async function syncConfirmedToPromptRule(row: KnowledgeRow): Promise<void> {
  if (row.importance < 7) return;
  const state = row.conversation_state;
  const actionType = state
    ? (Object.prototype.hasOwnProperty.call(KNOWLEDGE_STATE_TO_ACTION, state)
        ? KNOWLEDGE_STATE_TO_ACTION[state]
        : null)
    : null;
  const { error } = await supabase.from("ai_prompt_rules").upsert(
    {
      rule_key: `LEARN-${row.id}`,
      action_type: actionType,
      condition_key: null,
      condition_value: null,
      rule_text: row.content.slice(0, 500),
      reason: `ai_reply_knowledge自動昇格: ${row.title.slice(0, 100)}`,
      priority: 8,
      is_active: true,
    },
    { onConflict: "rule_key" }
  );
  if (error) console.warn("[knowledge-promote] sync failed:", error.message);
}

// ⑤ 昇格ロジック一元化: hypothesis → confirmed 昇格の単一エントリポイント
// promoted_by / promoted_at を記録して「誰が・いつ昇格させたか」を追跡可能にする。
// row（title/content 等）が渡された場合は ai_prompt_rules への同期も行う。
export type PromotedBy =
  | "rpc_auto"            // update_knowledge_feedback_by_pairs / confirm_knowledge_feedback のRPC内自動昇格
  | "analyze_diffs_tier1" // analyze-diffs cron のTier1昇格
  | "auto_judge"          // 自動判定
  | "batch_eval"          // eval-winning-pattern の週次バッチ昇格
  | "bulk_judge"          // bulk-judge-knowledge のSonnet審査昇格
  | "human_feedback";     // 竹内さんの手動確認・回答経由

export async function promoteToConfirmed(
  id: string,
  promotedBy: PromotedBy,
  row?: { title?: string; content?: string; conversation_state?: string | null; importance?: number }
): Promise<void> {
  const { error } = await supabase.from("ai_reply_knowledge").update({
    hypothesis_status: "confirmed",
    promoted_by: promotedBy,
    promoted_at: new Date().toISOString(),
  }).eq("id", id);
  if (error) {
    console.warn("[knowledge-promote] promoteToConfirmed failed:", error.message);
    return;
  }
  if (row) {
    await syncConfirmedToPromptRule({
      id,
      title: row.title ?? "",
      content: row.content ?? "",
      conversation_state: row.conversation_state ?? null,
      importance: row.importance ?? 0,
    });
  }
}

// 却下された知識の ai_prompt_rules を無効化
export async function deactivatePromptRule(knowledgeId: string): Promise<void> {
  const { error } = await supabase.from("ai_prompt_rules")
    .update({ is_active: false })
    .eq("rule_key", `LEARN-${knowledgeId}`);
  if (error) console.warn("[knowledge-promote] deactivate failed:", error.message);
}
