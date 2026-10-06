// app/lib/household-change-server.ts — 世帯の変わり目で検索の条件を直す（DB）。決め方は household-change.ts／読み方は condition-reading.ts
// 2026-10-06 ⑫ 竹内さん「一人になった場合など連動して物件検索の条件も変更されるようにする」（あかり）
//   条件の直しは普段の道（property_condition_history に p4 で記録＝条件の画面の「戻す」で戻せる・追加条件の帯に auto の1行）
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordConditionHistory, conditionSourceTag } from "@/app/lib/condition-history";
import { householdChangeOf, smallerOkOf } from "@/app/lib/condition-reading";
import { planHouseholdConditions } from "@/app/lib/household-change";

const jstStamp = () => {
  const j = new Date(Date.now() + 9 * 3600_000);
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${String(j.getUTCHours()).padStart(2, "0")}:${String(j.getUTCMinutes()).padStart(2, "0")}`;
};

/** お客様の発言に世帯の変わり目・「小さくて大丈夫」があるか（webhook の入口で軽く見る） */
export function hasHouseholdSignal(text: string): boolean {
  return !!householdChangeOf(text) || smallerOkOf(text);
}

/**
 * 会話の紐付け先（property_customers）の条件を直す。子の行（物置 等）は触らない。
 * @returns 直した列（無ければ空）
 */
export async function applyHouseholdChange(db: SupabaseClient, convId: string, text: string, messageId: string | null): Promise<{ pcId: string | null; updates: Record<string, unknown>; banner: string | null }> {
  const change = householdChangeOf(text);
  const smaller = smallerOkOf(text);
  const none = { pcId: null, updates: {}, banner: null };
  if (!change && !smaller) return none;
  const { data: conv } = await db.from("conversations").select("property_customer_id").eq("id", convId).maybeSingle();
  const pcId = (conv?.property_customer_id as string | null | undefined) ?? null;
  if (!pcId) return none;
  const { data: cur } = await db.from("property_customers").select("preferences, other_requests, floor_area_min, floor_plan, additional_conditions").eq("id", pcId).maybeSingle();
  if (!cur) return none;
  const plan = planHouseholdConditions(cur as never, change, smaller);
  if (!plan.banner) return none;
  const line = `[${jstStamp()}|auto] ${plan.banner}`;
  const prev = (cur.additional_conditions as string | null) ?? "";
  const changedCols = Object.keys(plan.updates).length > 0;
  const row: Record<string, unknown> = {
    ...plan.updates,
    ...(prev.includes(plan.banner) ? {} : { additional_conditions: prev ? `${prev}\n${line}` : line }),
    ...(changedCols ? { updated_at: new Date().toISOString(), last_property_sent_at: null, rp_update_days: null } : {}),
  };
  if (!Object.keys(row).length) return { pcId, updates: {}, banner: plan.banner };
  const { error } = await db.from("property_customers").update(row).eq("id", pcId);
  if (error) { console.warn("[household-change] update:", error.message); return none; }
  if (changedCols) void recordConditionHistory(db, pcId, cur as Record<string, unknown>, plan.updates, conditionSourceTag("p4", messageId)).catch(() => {});
  console.log(JSON.stringify({ tag: "household-change", convId, pcId, kind: change?.kind ?? null, smaller, removed: plan.removed, cols: Object.keys(plan.updates) }));
  return { pcId, updates: plan.updates, banner: plan.banner };
}
