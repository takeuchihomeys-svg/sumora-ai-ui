// app/lib/proposal-range-server.ts（サーバー専用・読むだけ）— このお客様に広げて提案してよい範囲（proposal-range.ts）の材料を DB から集める
//   ・ブレインの判断: そのお客様の一番新しい会話の conversations.suggested_aix_meta（customer_mindset・condition_change_type）＝ブレインが毎回の判断で書いた物を読むだけ
//   ・お客様の言葉の記録: property_customers.requirement_strength（エリア・家賃の強さ）
//   ・決め手の条件（closing-target-server・まだ見つかっていない像の型と気に入った部屋の駅）。呼ぶ側がもう読んでいれば渡す（二度読まない）
//   ここで決めた範囲は判定（judgeProperty の opts.proposalRange）に渡すだけ。ブレインの入力（会話・条件・セーブデータ）には書き戻さない（P1 0593a0aa）
import type { SupabaseClient } from "@supabase/supabase-js";
import { proposalRangeEnabled, proposalRangeFor, type ProposalMaterials, type ProposalRange } from "@/app/lib/proposal-range";
import type { ClosingTargetState } from "@/app/lib/closing-target";

export type ProposalRangeLoad = { range: ProposalRange | null; materials: ProposalMaterials | null; error: string | null };

/** ブレインの判断（suggested_aix_meta）・要望の強さ・決め手の条件 → 材料（純） */
export function proposalMaterialsOf(meta: Record<string, any> | null | undefined, requirementStrength: unknown, closing: ClosingTargetState | null | undefined): ProposalMaterials {
  let rs: any = requirementStrength ?? null;
  if (typeof rs === "string") { try { rs = JSON.parse(rs); } catch { rs = null; } }
  const mindset = meta?.customer_mindset ?? null;
  const live = closing && closing.status !== "found" ? closing : null;
  return {
    brainState: typeof mindset?.state === "string" ? mindset.state : null,
    brainGap: mindset?.decideGap && typeof mindset.decideGap === "object" ? { point: mindset.decideGap.point ?? null, solve: mindset.decideGap.solve ?? null } : null,
    conditionChangeType: typeof meta?.condition_change_type === "string" ? meta.condition_change_type : null,
    areaStrength: rs?.area?.strength ?? null,
    rentStrength: rs?.rent_max?.strength ?? null,
    closingKinds: live ? live.target.kinds.map(String) : [],
    favoriteStations: live ? (live.target.favorite?.stations ?? []).map((s) => s.station).filter(Boolean) : [],
  };
}

export async function loadProposalRange(
  db: SupabaseClient,
  ids: { propertyCustomerId: string | null | undefined; conversationId?: string | null },
  opts: { closing?: ClosingTargetState | null; now?: Date } = {},
): Promise<ProposalRangeLoad> {
  if (!proposalRangeEnabled() || !ids.propertyCustomerId) return { range: null, materials: null, error: null };
  try {
    const convQ = ids.conversationId
      ? db.from("conversations").select("id, suggested_aix_meta").eq("id", ids.conversationId).maybeSingle()
      : db.from("conversations").select("id, suggested_aix_meta").eq("property_customer_id", ids.propertyCustomerId).order("updated_at", { ascending: false }).limit(1).maybeSingle();
    const [{ data: pc }, { data: conv }] = await Promise.all([
      db.from("property_customers").select("id, desired_area, preferences, other_requests, requirement_strength").eq("id", ids.propertyCustomerId).maybeSingle(),
      convQ,
    ]);
    if (!pc) return { range: null, materials: null, error: "お客様が無い" };
    let closing = opts.closing;
    if (closing === undefined) {
      try {
        const { loadClosingTargetState } = await import("@/app/lib/closing-target-server");
        closing = await loadClosingTargetState(db, { propertyCustomerId: ids.propertyCustomerId, conversationId: (conv as { id?: string } | null)?.id ?? null }, { now: opts.now });
      } catch { closing = null; }
    }
    const materials = proposalMaterialsOf((conv as { suggested_aix_meta?: Record<string, any> | null } | null)?.suggested_aix_meta ?? null, (pc as { requirement_strength?: unknown }).requirement_strength, closing ?? null);
    return { range: proposalRangeFor(pc as { desired_area?: string | null; preferences?: string | null; other_requests?: string | null }, materials), materials, error: null };
  } catch (e) {
    return { range: null, materials: null, error: e instanceof Error ? e.message : String(e) };
  }
}
