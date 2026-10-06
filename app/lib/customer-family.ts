// app/lib/customer-family.ts — 1人のお客様の2つ目の探し物（子の行）を親と一緒に扱う（2026-10-06 v2.5.78・⑯）
//
// ⑫ の作り（ゆいと: 親 23f2f823・子「ゆいと（物置）」887420dc・profile_label=物置・parent_customer_id=親）:
//   子は自分の条件で検索するが、会話・LINE（line_user_id）は持たない＝お客様に届けるのは親の会話。
//   → 送付済み（sent_properties）は親の会話で送った物も同じ人に届いている＝子の送付済みは「子＋親」で見る（送り直さない）。
//     売上サポの回（property_pickups）は子の id のまま（子の探し物として残す）・会話は親の会話に結ぶ（AIXツールで親の会話から見える）。
import type { SupabaseClient } from "@supabase/supabase-js";

export type FamilyRow = { id: string; parent_customer_id?: string | null };

/** 純: 送付済みを見るお客様の id（子なら子＋親・それ以外は自分だけ） */
export function familyIds(row: FamilyRow | null | undefined): string[] {
  if (!row || !row.id) return [];
  const ids = [String(row.id)];
  if (row.parent_customer_id && String(row.parent_customer_id) !== String(row.id)) ids.push(String(row.parent_customer_id));
  return ids;
}

/** お客様の行を読んで送付済みを見る id を返す（読めない時は自分だけ） */
export async function familyIdsFor(sb: SupabaseClient, customerId: string): Promise<string[]> {
  if (!customerId) return [];
  const { data } = await sb.from("property_customers").select("id, parent_customer_id").eq("id", customerId).maybeSingle();
  return data ? familyIds(data as FamilyRow) : [customerId];
}

/** 子の行なら親の会話の id（子は自分の会話を持たない）。子でなければ null（今まで通り） */
export async function parentConversationFor(sb: SupabaseClient, customerId: string): Promise<string | null> {
  if (!customerId) return null;
  const { data: row } = await sb.from("property_customers").select("parent_customer_id").eq("id", customerId).maybeSingle();
  const parent = (row as { parent_customer_id?: string | null } | null)?.parent_customer_id ?? null;
  if (!parent) return null;
  const { data: conv } = await sb.from("conversations").select("id").eq("property_customer_id", parent).order("updated_at", { ascending: false }).limit(1).maybeSingle();
  return ((conv as { id?: string } | null)?.id) ?? null;
}
