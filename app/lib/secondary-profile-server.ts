// app/lib/secondary-profile-server.ts — 2つ目の探し物を子の行に書く（DB）。決め方は secondary-profile.ts／読み方は condition-reading.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordConditionHistory, conditionSourceTag } from "@/app/lib/condition-history";
import { secondaryConditionsOf, type SecondaryNeed } from "@/app/lib/condition-reading";
import { planSecondaryProfile, secondaryProfileName, mergeSecondaryConditions, type ChildRow } from "@/app/lib/secondary-profile";

const jstStamp = () => {
  const j = new Date(Date.now() + 9 * 3600_000);
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${String(j.getUTCHours()).padStart(2, "0")}:${String(j.getUTCMinutes()).padStart(2, "0")}`;
};

/**
 * お客様の発言が2つ目の探し物（need）の時: 会話の紐付け先（親）の子を作る・直す。親の条件は触らない。
 *   親の追加条件の帯に「別の探し物『物置』として分けました（ゆいと（物置））」を出す（スタッフ・ブレインが2つあると分かる）
 */
export async function routeSecondaryNeed(db: SupabaseClient, convId: string, text: string, need: SecondaryNeed, messageId: string | null): Promise<{ childId: string | null; created: boolean; changed: Record<string, unknown> }> {
  const none = { childId: null, created: false, changed: {} };
  const { data: conv } = await db.from("conversations").select("property_customer_id").eq("id", convId).maybeSingle();
  const parentId = (conv?.property_customer_id as string | null | undefined) ?? null;
  if (!parentId) return none;
  const { data: parent } = await db.from("property_customers").select("id, customer_name, status, account, assignee, additional_conditions, parent_customer_id").eq("id", parentId).maybeSingle();
  if (!parent || parent.parent_customer_id) return none;
  const { data: kids } = await db.from("property_customers").select("id, profile_label, updated_at, created_at, rent_max, desired_area, floor_plan, other_requests").eq("parent_customer_id", parentId);
  const plan = planSecondaryProfile((kids ?? []) as ChildRow[], need.label);
  const read = secondaryConditionsOf(text);
  let childId: string | null = null;
  let created = false;
  let changed: Record<string, unknown> = {};
  if (plan.action === "create") {
    const row = {
      customer_name: secondaryProfileName(parent.customer_name as string | null, plan.label),
      profile_label: plan.label, parent_customer_id: parentId,
      status: (parent.status as string | null) ?? "hot", account: (parent.account as string | null) ?? null, assignee: (parent.assignee as string | null) ?? null,
      ...mergeSecondaryConditions(null, read),
    };
    const { data: ins, error } = await db.from("property_customers").insert(row).select("id").single();
    if (error || !ins) { console.warn("[secondary-profile] insert:", error?.message); return none; }
    childId = String(ins.id); created = true; changed = row;
    void recordConditionHistory(db, childId, {}, row, conditionSourceTag("p4", messageId)).catch(() => {});
  } else {
    const cur = (kids ?? []).find((k) => k.id === plan.id) as Record<string, unknown> | undefined;
    changed = { ...mergeSecondaryConditions(cur as never, read), ...(plan.relabel ? { profile_label: plan.label, customer_name: secondaryProfileName(parent.customer_name as string | null, plan.label) } : {}) };
    childId = plan.id;
    if (Object.keys(changed).length) {
      const { error } = await db.from("property_customers").update({ ...changed, updated_at: new Date().toISOString() }).eq("id", plan.id);
      if (error) { console.warn("[secondary-profile] update:", error.message); return none; }
      void recordConditionHistory(db, plan.id, cur ?? {}, changed, conditionSourceTag("p4", messageId)).catch(() => {});
    }
  }
  // 親の帯（新着要望）に分けた事を出す
  const line = `[${jstStamp()}|auto] 別の探し物「${plan.label}」として分けました（${secondaryProfileName(parent.customer_name as string | null, plan.label)}）${read.rent_max ? `・家賃〜${read.rent_max / 10000}万` : ""}`;
  const prev = (parent.additional_conditions as string | null) ?? "";
  if (!prev.includes(`別の探し物「${plan.label}」`) || created) {
    await db.from("property_customers").update({ additional_conditions: prev ? `${prev}\n${line}` : line }).eq("id", parentId);
  }
  console.log(JSON.stringify({ tag: "secondary-profile", convId, parentId, childId, created, label: plan.label, changed: Object.keys(changed) }));
  return { childId, created, changed };
}
