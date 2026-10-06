// app/lib/requirement-strength-server.ts — LINE の発言から要望の強さを読み直して property_customers.requirement_strength に書く（DB）
// 2026-10-06 ⑫ 竹内（ゆいと 10月後半入居）。読み方は requirement-strength.ts（純関数）
import type { SupabaseClient } from "@supabase/supabase-js";
import { readRequirementStrengths, mergeRequirementStrengths, normalizeRequirementStrengths } from "@/app/lib/requirement-strength";

/** 会話の紐付け先の要望の強さを、直近14日のお客様の発言から読み直す（同じなら書かない） */
export async function refreshRequirementStrength(db: SupabaseClient, convId: string): Promise<Record<string, unknown> | null> {
  const { data: conv } = await db.from("conversations").select("property_customer_id").eq("id", convId).maybeSingle();
  const pcId = (conv?.property_customer_id as string | null | undefined) ?? null;
  if (!pcId) return null;
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const [{ data: msgs }, { data: pc }] = await Promise.all([
    db.from("messages").select("text, created_at").eq("conversation_id", convId).eq("sender", "customer").gte("created_at", since).order("created_at", { ascending: true }).limit(200),
    db.from("property_customers").select("requirement_strength").eq("id", pcId).maybeSingle(),
  ]);
  const read = readRequirementStrengths(((msgs ?? []) as Array<{ text: string | null; created_at: string }>).map((m) => ({ text: m.text, at: m.created_at })));
  if (!Object.keys(read).length) return null;
  const before = normalizeRequirementStrengths(pc?.requirement_strength);
  const next = mergeRequirementStrengths(before, read);
  if (JSON.stringify(next) === JSON.stringify(before)) return null;
  const { error } = await db.from("property_customers").update({ requirement_strength: next }).eq("id", pcId);
  if (error) { console.warn("[requirement-strength]", error.message); return null; }
  console.log(JSON.stringify({ tag: "requirement-strength", convId, pcId, next: Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v?.strength])) }));
  return next as Record<string, unknown>;
}
