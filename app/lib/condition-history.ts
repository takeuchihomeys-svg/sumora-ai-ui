import type { SupabaseClient } from "@supabase/supabase-js";

// ── 条件変更履歴の記録（property_condition_history INSERT）────────────────────
// property_customers は最新値しか持たないため、条件フィールドの変更を履歴化して
// brain の condition_change_type 推測を事実で接地させる。
// 必ず「UPDATE 成功後」に fire-and-forget で呼ぶこと（await しない・失敗は warn のみ）。
export async function recordConditionHistory(
  db: SupabaseClient,
  propertyCustomerId: string,
  oldRow: Record<string, unknown> | null,
  updates: Record<string, unknown>,
  sourceMessageId?: string, // line_message_id など変更の根拠（カラムはTEXT）
): Promise<void> {
  try {
    const TRACKED = [
      "desired_area", "floor_plan", "rent_max", "rent_min",
      "walk_minutes", "move_in_time", "building_age", "initial_cost_limit", "other_requests",
    ];
    const rows = TRACKED
      .filter((f) => f in updates && String(oldRow?.[f] ?? "") !== String(updates[f] ?? ""))
      .map((f) => ({
        property_customer_id: propertyCustomerId,
        changed_field: f,
        old_value: oldRow?.[f] != null ? String(oldRow[f]) : null,
        new_value: updates[f] != null ? String(updates[f]) : null,
        source_message_id: sourceMessageId ?? null,
      }));
    if (rows.length === 0) return;
    const { error } = await db.from("property_condition_history").insert(rows);
    if (error) console.warn("[condition-history]", error.message);
  } catch (e) {
    console.warn("[condition-history]", e);
  }
}
