/**
 * 束の学習成果を消さない（2026-11-17）
 *
 *   実測: 本番 fresh / 約31分ごとの再生成（source_rows=6000）が
 *   shots.learned の solid 96→0 を繰り返す。直前1件だけ見ると連鎖消失。
 *
 *   → 直近履歴から learned / foundation_audit / 駅遷移 を継ぐ。
 *   → 継いでも solid=0 のままなら「消す書き込み」として拒否できる判定を返す。
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type BundlePreserveResult = {
  solid: number;
  preserved: boolean;
  preserved_solid: number;
  has_fa: boolean;
  has_transit: boolean;
  /** true ならこの束を最新として書いてよい（消す書き込みではない） */
  safe_to_write: boolean;
  why: string;
};

export function countLearnedSolid(bundle: unknown): { solid: number; learned: unknown } {
  const learned = (bundle as { shots?: { learned?: unknown } } | null)?.shots?.learned;
  let solid = 0;
  if (learned && typeof learned === "object") {
    for (const list of Object.values(learned as Record<string, unknown>)) {
      for (const f of Array.isArray(list) ? list : []) {
        const rec = f as { x?: unknown; y?: unknown; n?: unknown };
        if (typeof rec?.x !== "number" || typeof rec?.y !== "number") continue;
        if ((Number(rec.n) || 0) >= 3) solid++;
      }
    }
  }
  return { solid, learned: learned ?? null };
}

export function hasStationTransitSteps(bundle: unknown): boolean {
  const sf = (bundle as { scene_flows?: Array<{ scene?: string; steps?: string[] }> } | null)?.scene_flows;
  const st = Array.isArray(sf) ? sf.find((x) => x.scene === "station") : null;
  return !!(st?.steps || []).some((s) => /駅の設定へ進む|沿線の設定へ戻る|one_station/.test(String(s)));
}

/**
 * 履歴から学習土台を継ぎ足す（破壊的に bundle を更新）。
 * lookback 既定20。
 */
export async function inheritLinkFoundations(
  sb: SupabaseClient,
  bundle: Record<string, unknown>,
  scope: string,
  opt: { lookback?: number; minSolid?: number } = {},
): Promise<BundlePreserveResult> {
  const lookback = Math.max(5, Math.min(40, opt.lookback ?? 20));
  const minSolid = opt.minSolid ?? 30;
  const neu0 = countLearnedSolid(bundle);
  const needLearned = neu0.solid < minSolid;
  const needFa = !bundle.foundation_audit;
  const needTransit = !hasStationTransitSteps(bundle);

  let preserved = false;
  let preserved_solid = 0;

  if (needLearned || needFa || needTransit) {
    const { data: prevs } = await sb
      .from("human_learn_profile")
      .select("bundle,created_at")
      .eq("scope", scope)
      .order("created_at", { ascending: false })
      .limit(lookback);

    for (const row of prevs || []) {
      const oldB = row.bundle;
      if (needLearned && !(bundle.shots as { preserved_learned?: boolean } | undefined)?.preserved_learned) {
        const old = countLearnedSolid(oldB);
        if (old.solid >= minSolid && old.learned && typeof old.learned === "object") {
          bundle.shots = {
            ...((bundle.shots as object) || {}),
            learned: old.learned,
            preserved_learned: true,
            preserved_solid: old.solid,
          };
          preserved = true;
          preserved_solid = old.solid;
        }
      }
      if (needFa && !bundle.foundation_audit) {
        const fa = (oldB as { foundation_audit?: unknown } | null)?.foundation_audit;
        if (fa && typeof fa === "object") bundle.foundation_audit = fa;
      }
      if (needTransit && !hasStationTransitSteps(bundle)) {
        const sf = (oldB as { scene_flows?: Array<{ scene?: string; steps?: string[]; runs?: number; ops?: number }> } | null)?.scene_flows;
        const st = Array.isArray(sf)
          ? sf.find((x) => x.scene === "station" && (x.steps || []).some((s) => /駅の設定へ進む|沿線の設定へ戻る/.test(String(s))))
          : null;
        if (st?.steps?.length) {
          const flows = Array.isArray(bundle.scene_flows)
            ? [...(bundle.scene_flows as Array<{ scene?: string; steps?: string[] }>)]
            : [];
          const ix = flows.findIndex((x) => x.scene === "station");
          if (ix >= 0) flows[ix] = { ...flows[ix], steps: st.steps };
          else flows.push({ scene: "station", steps: st.steps, runs: st.runs || 1, ops: st.ops || st.steps.length } as never);
          bundle.scene_flows = flows;
        }
      }
      const now = countLearnedSolid(bundle);
      if (now.solid >= minSolid && bundle.foundation_audit && hasStationTransitSteps(bundle)) break;
    }
  }

  const solid = countLearnedSolid(bundle).solid;
  const has_fa = !!bundle.foundation_audit;
  const has_transit = hasStationTransitSteps(bundle);

  // 履歴に良い束があるのに solid=0 のまま書くのは禁止
  let historyHadSolid = preserved_solid >= minSolid;
  if (!historyHadSolid) {
    const { data: check } = await sb
      .from("human_learn_profile")
      .select("bundle")
      .eq("scope", scope)
      .order("created_at", { ascending: false })
      .limit(lookback);
    for (const row of check || []) {
      if (countLearnedSolid(row.bundle).solid >= minSolid) {
        historyHadSolid = true;
        break;
      }
    }
  }

  const safe_to_write = solid >= minSolid || !historyHadSolid;
  const why = safe_to_write
    ? (preserved ? `引き継ぎsolid=${preserved_solid}` : solid >= minSolid ? `自前solid=${solid}` : "履歴にsolid無し・初回可")
    : `消す書き込み拒否（新solid=${solid}・履歴に≥${minSolid}あり）`;

  return { solid, preserved, preserved_solid, has_fa, has_transit, safe_to_write, why };
}
