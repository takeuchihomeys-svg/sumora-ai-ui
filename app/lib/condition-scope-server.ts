// app/lib/condition-scope-server.ts — ブレインが「今回だけ」と決めた言い直しの後始末（DB）。決め方は condition-change-scope.ts（純関数）
//
// 2026-09-27 竹内「一時調整か、そもそもの条件の切り替えかの判断をブレインが行う」
//   P4（webhook の条件抽出）はブレインより先に登録の条件を書く（積む前に直っているため）。ブレインが temporary と決めたら:
//   ① P4 がこの発言で書いた検索に効く列を、書く前の値へ戻す（履歴に「scope:temporary」で残す・間に人が直した列は戻さない）
//   ② この発言の条件をその回だけの上書き（SearchOverride）にして返す → 呼び出し元が AIX の検索（source=aix）の payload に載せる
// 2026-09-30 強化（竹内「一時調整でその一回限定して行うか、そもそもの条件自体を変えるのかの判断の部分も強化する」）:
//   ③ 弱い「今回だけ」の語（一旦・とりあえず）の時は、戻す先の登録の条件が空なら切り替えのまま（戻さない・上書きも作らない）＝初めての条件を消さない
//   ④ 判断を1か所（condition_scope_decisions）に残し、週のまとめ（weeklyConditionScope）がその後のスタッフの動きと照らして当たり外れを付ける
import { supabase } from "@/app/lib/supabase";
import { recordConditionHistory } from "@/app/lib/condition-history";
import {
  planScopeRevert, hasRegisteredConditions, labelScopeOutcome, scoreScopeDecisions, SCOPE_REVERT_FIELDS,
  type HistoryRowLite, type ScopeDecision, type ScopeOutcome,
} from "@/app/lib/condition-change-scope";
import { buildTemporaryOverride } from "@/app/lib/condition-scope-override";
import type { SearchOverride, RegisteredConditions } from "@/app/lib/search-override";

export const SCOPE_TEMPORARY_SOURCE = "scope:temporary";

export async function applyTemporaryScope(input: {
  conversationId: string;
  text: string;
  /** その発言の時刻（ブレインの analyzed_msg_ts）。これより前の履歴は戻さない */
  sinceIso: string | null | undefined;
  decision: ScopeDecision;
}): Promise<{ override: SearchOverride | null; reverted: Record<string, unknown>; notes: string[]; downgraded?: boolean; propertyCustomerId?: string | null }> {
  const empty = { override: null, reverted: {}, notes: [] as string[] };
  const { data: conv } = await supabase.from("conversations").select("property_customer_id").eq("id", input.conversationId).maybeSingle();
  const pcId = (conv?.property_customer_id as string | null | undefined) ?? null;
  if (!pcId) return empty;
  const cols = [...SCOPE_REVERT_FIELDS, "area_mode", "pet", "floor_area_max"].join(",");
  const { data: pcRow } = await supabase.from("property_customers").select(cols).eq("id", pcId).maybeSingle();
  const pc = (pcRow ?? null) as Record<string, unknown> | null;
  if (!pc) return empty;
  const weak = input.decision.by === "text_temporary_weak";

  let reverted: Record<string, unknown> = {};
  const notes: string[] = [];
  let plan: { updates: Record<string, unknown>; skipped: string[] } = { updates: {}, skipped: [] };
  if (input.sinceIso) {
    const since = new Date(Date.parse(input.sinceIso) - 10_000).toISOString();
    const { data: hist } = await supabase.from("property_condition_history")
      .select("changed_field, old_value, new_value, created_at")
      .eq("property_customer_id", pcId).gte("created_at", since).order("created_at", { ascending: true }).limit(50);
    plan = planScopeRevert((hist ?? []) as HistoryRowLite[], pc, input.sinceIso, { keepNewFields: weak });
  }
  // ③ 弱い語で、戻した後の登録の条件が空（＝この発言が初めての条件）なら今回だけにしない
  if (weak && !hasRegisteredConditions({ ...pc, ...plan.updates })) {
    const note = "弱い「今回だけ」の語だが登録の条件がまだ無い（初めての条件）→ 切り替えのまま（戻さない・上書きなし）";
    console.log(JSON.stringify({ tag: "condition-scope:weak-downgrade", conversationId: input.conversationId, pcId, evidence: input.decision.evidence }));
    return { override: null, reverted: {}, notes: [note], downgraded: true, propertyCustomerId: pcId };
  }
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
  const reg = { ...pc, ...reverted } as RegisteredConditions;
  const built = buildTemporaryOverride(input.text, reg);
  notes.push(...built.notes);
  console.log(JSON.stringify({ tag: "condition-scope:temporary", conversationId: input.conversationId, pcId, by: input.decision.by, evidence: input.decision.evidence, reverted, override: built.override, notes }));
  return { override: built.override, reverted, notes, propertyCustomerId: pcId };
}

// ─────────────────────────── ④ 判断の記録と週のまとめ（2026-09-30） ───────────────────────────

const DECISIONS_TABLE = "condition_scope_decisions";
let tableMissingLogged = false;
const isMissingTable = (e: { message?: string; code?: string } | null | undefined) => !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|Could not find the table/i.test(String(e.message ?? "")));

/**
 * 判断を1行残す（fire-and-forget で呼ぶ・失敗は warn だけ）。表が無ければ（migrate-schema 前）何もしない。
 *   text は発言の頭 200字（個人情報を足さない＝会話の文そのもの。名前・電話は入れない）
 */
export async function recordScopeDecision(input: {
  conversationId: string;
  messageTs: string | null | undefined;
  text: string;
  decision: ScopeDecision;
  brainScope: unknown;
  conditionChangeType: string | null | undefined;
  override?: SearchOverride | null;
  reverted?: Record<string, unknown> | null;
  downgraded?: boolean;
  propertyCustomerId?: string | null;
}): Promise<void> {
  try {
    let pcId = input.propertyCustomerId ?? null;
    if (!pcId) {
      const { data: conv } = await supabase.from("conversations").select("property_customer_id").eq("id", input.conversationId).maybeSingle();
      pcId = (conv?.property_customer_id as string | null | undefined) ?? null;
    }
    const { error } = await supabase.from(DECISIONS_TABLE).insert({
      conversation_id: input.conversationId,
      property_customer_id: pcId,
      message_ts: input.messageTs ?? null,
      text_head: String(input.text ?? "").slice(0, 200),
      scope: input.downgraded ? "permanent" : input.decision.scope,
      decided_by: input.downgraded ? `${input.decision.by}:downgraded` : input.decision.by,
      evidence: input.decision.evidence,
      brain_scope: typeof input.brainScope === "string" ? input.brainScope.slice(0, 20) : null,
      condition_change_type: input.conditionChangeType ?? null,
      search_override: input.override ?? null,
      reverted: input.reverted && Object.keys(input.reverted).length ? input.reverted : null,
    });
    if (error) {
      if (isMissingTable(error)) { if (!tableMissingLogged) { tableMissingLogged = true; console.warn("[condition-scope] condition_scope_decisions が無い（/api/migrate-schema を流す）"); } return; }
      console.warn("[condition-scope] record decision:", error.message);
    }
  } catch (e) {
    console.warn("[condition-scope] record decision failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * 週のまとめ（search-audit-weekly から呼ぶ）: 72時間より前で当たり外れがまだの判断に、その後のスタッフの動き（人の手直し・メモの一時調整・返事）で
 *   truth を付け、直近28日の当たり（規則ごと）を返す。dry は数えるだけ（書かない）。表が無ければ skipped
 */
export async function weeklyConditionScope(opts: { dry?: boolean; nowMs?: number } = {}): Promise<Record<string, unknown>> {
  const nowMs = opts.nowMs ?? Date.now();
  const since28 = new Date(nowMs - 28 * 86400_000).toISOString();
  const until = new Date(nowMs - 72 * 3600_000).toISOString();
  const { data, error } = await supabase.from(DECISIONS_TABLE)
    .select("id, created_at, conversation_id, property_customer_id, message_ts, scope, decided_by, outcome")
    .gte("created_at", since28).limit(3000);
  if (error) return isMissingTable(error) ? { ok: true, skipped: "no_table" } : { ok: false, error: error.message };
  type Row = { id: string; created_at: string; conversation_id: string; property_customer_id: string | null; message_ts: string | null; scope: string; decided_by: string; outcome: string | null };
  const rows = (data ?? []) as Row[];
  let labeled = 0;
  for (const r of rows) {
    if (r.outcome || r.created_at > until) continue;
    const at = r.message_ts ?? r.created_at;
    const endIso = new Date(Date.parse(at) + 96 * 3600_000).toISOString();
    const [hist, cmds, staff] = await Promise.all([
      r.property_customer_id
        ? supabase.from("property_condition_history").select("changed_field, old_value, new_value, created_at, source_message_id").eq("property_customer_id", r.property_customer_id).gte("created_at", at).lte("created_at", endIso).limit(200)
        : Promise.resolve({ data: [] as unknown[] }),
      r.property_customer_id
        ? supabase.from("automation_commands").select("created_at, payload, customer_ids").contains("customer_ids", [r.property_customer_id]).gte("created_at", at).lte("created_at", endIso).limit(50)
        : Promise.resolve({ data: [] as unknown[] }),
      supabase.from("messages").select("text, created_at").eq("conversation_id", r.conversation_id).eq("sender", "staff").gte("created_at", at).lte("created_at", endIso).order("created_at", { ascending: true }).limit(5),
    ]);
    const overrideAt = ((cmds.data ?? []) as Array<{ created_at: string; payload: Record<string, unknown> | null }>)
      .filter((c) => c.payload && c.payload.source === "web_brain" && c.payload.search_override).map((c) => c.created_at);
    const lab = labelScopeOutcome(at, {
      history: (hist.data ?? []) as Array<HistoryRowLite & { source_message_id?: string | null }>,
      overrideAt,
      staffTexts: (staff.data ?? []) as Array<{ text: string | null; created_at: string }>,
    });
    r.outcome = lab.truth;
    labeled++;
    if (!opts.dry) {
      await supabase.from(DECISIONS_TABLE).update({ outcome: lab.truth, outcome_evidence: lab.evidence.slice(0, 200), outcome_recorded_at: new Date(nowMs).toISOString() }).eq("id", r.id);
    }
  }
  const score = scoreScopeDecisions(rows.filter((r) => r.outcome).map((r) => ({ scope: r.scope, by: r.decided_by, truth: r.outcome as ScopeOutcome })));
  return { ok: true, decisions_28d: rows.length, labeled_now: labeled, ...score };
}
