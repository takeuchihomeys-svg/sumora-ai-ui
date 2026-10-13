// app/lib/proposal-range-server.ts（サーバー専用・読むだけ）— このお客様に広げて提案してよい範囲（proposal-range.ts）の材料を DB から集める
//   ① 残り続ける記録（保留も付けてよい）: property_customers.requirement_strength
//   ② 続いている判断・記録（加点だけ）: brain_decision_logs の直近の判断（digest.ms＝customer_mindset の要約・14日・6件）・決め手の条件（closing-target-server）
//   ⚠ suggested_aix_meta（最新の1通の判断・発言のたびに null に戻る）は使わない＝記録の時と判定の時で段が変わらない（2026-10-13 確かめる人の重要2）
//   ここで決めた範囲は判定（judgeProperty の opts.proposalRange）に渡すだけ。ブレインの入力（会話・条件・セーブデータ）には書き戻さない（P1 0593a0aa）
import type { SupabaseClient } from "@supabase/supabase-js";
import { proposalRangeEnabled, proposalRangeFor, brainRecentOfDigest, BRAIN_RECENT_MAX, BRAIN_RECENT_DAYS, type ProposalMaterials, type ProposalRange } from "@/app/lib/proposal-range";
import type { ClosingTargetState } from "@/app/lib/closing-target";

export type ProposalRangeLoad = { range: ProposalRange | null; materials: ProposalMaterials | null; error: string | null };

/** 要望の強さ・決め手の条件・ブレインの直近の判断（digest の配列・新しい順）→ 材料（純） */
export function proposalMaterialsOf(requirementStrength: unknown, closing: ClosingTargetState | null | undefined, brainDigests: ReadonlyArray<{ ms?: unknown } | null | undefined> = []): ProposalMaterials {
  let rs: any = requirementStrength ?? null;
  if (typeof rs === "string") { try { rs = JSON.parse(rs); } catch { rs = null; } }
  const live = closing && closing.status !== "found" ? closing : null;
  return {
    areaStrength: rs?.area?.strength ?? null,
    rentStrength: rs?.rent_max?.strength ?? null,
    closingKinds: live ? live.target.kinds.map(String) : [],
    favoriteStations: live ? (live.target.favorite?.stations ?? []).map((s) => s.station).filter(Boolean) : [],
    brainRecent: brainDigests.map((d) => brainRecentOfDigest(d?.ms)).filter((x): x is NonNullable<typeof x> => !!x),
  };
}

export async function loadProposalRange(
  db: SupabaseClient,
  ids: { propertyCustomerId: string | null | undefined; conversationId?: string | null },
  opts: { closing?: ClosingTargetState | null; now?: Date } = {},
): Promise<ProposalRangeLoad> {
  if (!proposalRangeEnabled() || !ids.propertyCustomerId) return { range: null, materials: null, error: null };
  try {
    const now = opts.now ?? new Date();
    let convId = ids.conversationId ?? null;
    const { data: pc } = await db.from("property_customers").select("id, desired_area, preferences, other_requests, requirement_strength").eq("id", ids.propertyCustomerId).maybeSingle();
    if (!pc) return { range: null, materials: null, error: "お客様が無い" };
    if (!convId) {
      const { data } = await db.from("conversations").select("id").eq("property_customer_id", ids.propertyCustomerId).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      convId = (data as { id?: string } | null)?.id ?? null;
    }
    let digests: Array<{ ms?: unknown }> = [];
    if (convId) {
      const { data } = await db.from("brain_decision_logs").select("digest, created_at").eq("conversation_id", convId)
        .gte("created_at", new Date(now.getTime() - BRAIN_RECENT_DAYS * 86400_000).toISOString()).lte("created_at", now.toISOString())
        .order("created_at", { ascending: false }).limit(BRAIN_RECENT_MAX * 3);
      digests = ((data ?? []) as Array<{ digest?: { ms?: unknown } | null }>).map((r) => r.digest ?? {}).filter((d) => typeof d.ms === "string" && d.ms).slice(0, BRAIN_RECENT_MAX);
    }
    let closing = opts.closing;
    if (closing === undefined) {
      try {
        const { loadClosingTargetState } = await import("@/app/lib/closing-target-server");
        closing = await loadClosingTargetState(db, { propertyCustomerId: ids.propertyCustomerId, conversationId: convId }, { now });
      } catch { closing = null; }
    }
    const materials = proposalMaterialsOf((pc as { requirement_strength?: unknown }).requirement_strength, closing ?? null, digests);
    return { range: proposalRangeFor(pc as { desired_area?: string | null; preferences?: string | null; other_requests?: string | null }, materials), materials, error: null };
  } catch (e) {
    return { range: null, materials: null, error: e instanceof Error ? e.message : String(e) };
  }
}
