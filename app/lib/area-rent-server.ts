// app/lib/area-rent-server.ts（サーバー専用・DB を読む）
// お客様の希望のエリア（area_plan の近い区・希望の区・希望の駅の区）と間取りで、相場の材料（rent_observations）を読み、
// area-rent-explain.buildRentMarket に渡す。材料のため方は DB のトリガー（migrate-schema の rent_observations の節）。
import { supabase } from "@/app/lib/supabase";
import { parseAreaWant, customerAreaPlan } from "@/app/lib/area-want";
import type { AreaPlan } from "@/app/lib/osaka-area-profile";
import { wardOfStation } from "@/app/lib/osaka-geo";
import { buildRentMarket, RENT_EXPLAIN_RULE, type RentMarket, type RentObs } from "@/app/lib/area-rent-explain";

/** フランチャイズの店（今は大阪の1店だけ） */
export const DEFAULT_BRANCH = "osaka";

export type CustomerAreaInput = {
  desired_area?: string | null;
  preferences?: string | null;
  other_requests?: string | null;
  floor_plan?: string | null;
  rent_max?: number | null;
  pet?: boolean | null;
};

/**
 * 相場を数える区。area_plan がある時は基準の駅から直線 RENT_EXPLAIN_RULE.coreKm 以内の駅がある区だけ
 * （「なんば・梅田周辺の」と言える近さ。電車15分の線だと住吉区・生野区まで入り、相場が「周辺」でなくなる）。
 * 無ければ希望の区と希望の駅の区
 */
export function customerWards(c: CustomerAreaInput, plan: AreaPlan | null): string[] {
  if (plan) return plan.wards.filter((w) => w.km != null && w.km <= RENT_EXPLAIN_RULE.coreKm).map((w) => w.ward);
  const want = parseAreaWant(c.desired_area, [c.preferences, c.other_requests].filter(Boolean).join("\n"));
  const out = new Set<string>(want.wards);
  for (const s of want.stations) { const w = wardOfStation(s.station); if (w) out.add(w); }
  return [...out];
}

/** 相場の材料を読む（区で絞る・1,000行ずつ） */
export async function loadRentObservations(wards: string[], branch = DEFAULT_BRANCH): Promise<RentObs[]> {
  if (!wards.length) return [];
  const out: RentObs[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await supabase
      .from("rent_observations")
      .select("ward, plan_group, rent_total, pet")
      .eq("branch_id", branch)
      .in("ward", wards)
      .not("rent_total", "is", null)
      .range(from, from + 999);
    if (error || !data) break;
    out.push(...(data as RentObs[]));
    if (data.length < 1000) break;
  }
  return out;
}

/** お客様1人の area_plan と相場（失敗しても null で返す＝検索・判定は止めない） */
export async function customerAreaAndRent(c: CustomerAreaInput): Promise<{ areaPlan: AreaPlan | null; rentMarket: RentMarket | null }> {
  const freeText = [c.preferences, c.other_requests].filter(Boolean).join("\n");
  const plan = customerAreaPlan(c.desired_area, freeText);
  try {
    const wards = customerWards(c, plan);
    if (!wards.length) return { areaPlan: plan, rentMarket: null };
    const obs = await loadRentObservations(wards);
    const label = plan ? plan.anchors.map((a) => a.station).join("・") : null;
    return { areaPlan: plan, rentMarket: buildRentMarket(obs, { wards, floorPlan: c.floor_plan ?? null, rentMax: c.rent_max ?? null, pet: c.pet ?? null, label }) };
  } catch (e) {
    console.warn("[area-rent] 相場の読み込みに失敗:", e instanceof Error ? e.message : String(e));
    return { areaPlan: plan, rentMarket: null };
  }
}
