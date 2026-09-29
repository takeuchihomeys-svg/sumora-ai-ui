import type { SupabaseClient } from "@supabase/supabase-js";

// ── 根拠の発言（source_message_id）の書き方 ─────────────────────────────
// 2026-09-30 竹内（黒明様の事例）「条件の欄の各項目に根拠の発言を持たせる」: 旧は履歴 186行のうち source_message_id が入っていたのは2行だけで、
//   誰がどの発言で書いたかを追えなかった（経路C・ブレインの橋は履歴そのものを書いていなかった）。
//   列は TEXT のまま（migrate 不要）"<書き手>:<messages.id>" の形で入れる。書き手: p4／path_c／brain_bridge／condition_brain／format／screen_edit
export type ConditionWriter = "p4" | "path_c" | "brain_bridge" | "condition_brain" | "format" | "screen_edit" | "scope_temporary" | "other";
export function conditionSourceTag(writer: ConditionWriter, messageId?: string | null): string {
  return messageId ? `${writer}:${messageId}` : writer;
}
/** source_message_id を書き手と発言の id に分ける（旧の自由文・null も受ける） */
export function parseConditionSource(s: string | null | undefined): { writer: ConditionWriter | null; messageId: string | null } {
  const v = String(s ?? "").trim();
  if (!v) return { writer: null, messageId: null };
  const m = v.match(/^(p4|path_c|brain_bridge|condition_brain|format|screen_edit)(?::([0-9a-f-]{36}))?$/i);
  if (m) return { writer: m[1].toLowerCase() as ConditionWriter, messageId: m[2] ?? null };
  if (/^[0-9a-f-]{36}$/i.test(v)) return { writer: "other", messageId: v };
  return { writer: /一時|temporary/i.test(v) ? "scope_temporary" : "other", messageId: null };
}

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
    // 2026-09-27: 広さ・通勤・こだわり・NG も残す（検索に効く列の言い直しを後から追えるように。customerAt が数値の列を戻す）
    const TRACKED = [
      "desired_area", "floor_plan", "rent_max", "rent_min", "floor_area_min", "commute_station", "commute_minutes", "preferences", "ng_points",
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
