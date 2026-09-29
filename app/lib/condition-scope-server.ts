// app/lib/condition-scope-server.ts — ブレインが「今回だけ」と決めた言い直しの後始末（DB）。決め方は condition-change-scope.ts（純関数）
//
// 2026-09-27 竹内「一時調整か、そもそもの条件の切り替えかの判断をブレインが行う」
//   P4（webhook の条件抽出）はブレインより先に登録の条件を書く（積む前に直っているため）。ブレインが temporary と決めたら:
//   ① P4 がこの発言で書いた検索に効く列を、書く前の値へ戻す（履歴に「scope:temporary」で残す・間に人が直した列は戻さない）
//   ② この発言の条件をその回だけの上書き（SearchOverride）にして返す → 呼び出し元が AIX の検索（source=aix）の payload に載せる
import { supabase } from "@/app/lib/supabase";
import { recordConditionHistory } from "@/app/lib/condition-history";
import { planScopeRevert, SCOPE_REVERT_FIELDS, type HistoryRowLite, type ScopeDecision } from "@/app/lib/condition-change-scope";
import { buildTemporaryOverride } from "@/app/lib/condition-scope-override";
import type { SearchOverride, RegisteredConditions } from "@/app/lib/search-override";

export const SCOPE_TEMPORARY_SOURCE = "scope:temporary";

export async function applyTemporaryScope(input: {
  conversationId: string;
  text: string;
  /** その発言の時刻（ブレインの analyzed_msg_ts）。これより前の履歴は戻さない */
  sinceIso: string | null | undefined;
  decision: ScopeDecision;
}): Promise<{ override: SearchOverride | null; reverted: Record<string, unknown>; notes: string[] }> {
  const empty = { override: null, reverted: {}, notes: [] as string[] };
  const { data: conv } = await supabase.from("conversations").select("property_customer_id").eq("id", input.conversationId).maybeSingle();
  const pcId = (conv?.property_customer_id as string | null | undefined) ?? null;
  if (!pcId) return empty;
  const cols = [...SCOPE_REVERT_FIELDS, "area_mode", "pet", "floor_area_max"].join(",");
  const { data: pcRow } = await supabase.from("property_customers").select(cols).eq("id", pcId).maybeSingle();
  const pc = (pcRow ?? null) as Record<string, unknown> | null;
  if (!pc) return empty;

  let reverted: Record<string, unknown> = {};
  const notes: string[] = [];
  if (input.sinceIso) {
    const since = new Date(Date.parse(input.sinceIso) - 10_000).toISOString();
    const { data: hist } = await supabase.from("property_condition_history")
      .select("changed_field, old_value, new_value, created_at")
      .eq("property_customer_id", pcId).gte("created_at", since).order("created_at", { ascending: true }).limit(50);
    const plan = planScopeRevert((hist ?? []) as HistoryRowLite[], pc, input.sinceIso);
    if (plan.skipped.length) notes.push(...plan.skipped.map((s) => `戻さない: ${s}`));
    if (Object.keys(plan.updates).length) {
      const { error } = await supabase.from("property_customers").update({ ...plan.updates, updated_at: new Date().toISOString() }).eq("id", pcId);
      if (error) notes.push(`戻せなかった: ${error.message}`);
      else {
        reverted = plan.updates;
        void recordConditionHistory(supabase, pcId, pc, plan.updates, `${SCOPE_TEMPORARY_SOURCE}（${input.decision.by}${input.decision.evidence ? `「${input.decision.evidence}」` : ""}）`)
          .catch((e) => console.warn("[condition-scope] history:", e));
      }
    }
  }
  const reg = { ...pc, ...reverted } as RegisteredConditions;
  const built = buildTemporaryOverride(input.text, reg);
  notes.push(...built.notes);
  console.log(JSON.stringify({ tag: "condition-scope:temporary", conversationId: input.conversationId, pcId, by: input.decision.by, evidence: input.decision.evidence, reverted, override: built.override, notes }));
  return { override: built.override, reverted, notes };
}
