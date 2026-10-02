// app/lib/area-rent-server.ts（サーバー専用・DB を読む）
// お客様の希望のエリア（area_plan の近い区・希望の区・希望の駅の区）と間取りで、相場の材料（rent_observations）を読み、
// area-rent-explain.buildRentMarket に渡す。材料のため方は DB のトリガー（migrate-schema の rent_observations の節）。
import { supabase } from "@/app/lib/supabase";
import { parseAreaWant, customerAreaPlan } from "@/app/lib/area-want";
import type { AreaPlan } from "@/app/lib/osaka-area-profile";
import { wardOfStation, wardsAdjacent, WARD_COORDS } from "@/app/lib/osaka-geo";
import { buildRentMarket, wantedPlanGroups, wardComparisonSentence, RENT_EXPLAIN_RULE, type RentMarket, type RentObs } from "@/app/lib/area-rent-explain";
import { conditionMarket, conditionMarketFacts, realisticWithinBudget, type CondObs } from "@/app/lib/rent-condition-market";

/** フランチャイズの店（今は大阪の1店だけ） */
export const DEFAULT_BRANCH = "osaka";

export type CustomerAreaInput = {
  desired_area?: string | null;
  preferences?: string | null;
  other_requests?: string | null;
  floor_plan?: string | null;
  rent_max?: number | null;
  pet?: boolean | null;
  /** 築年数の上限（年） */
  building_age?: number | null;
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
      .select("ward, plan_group, rent_total, pet, building_age, walk_minutes, floor, structure, area_sqm, equipment")
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
    const rm = buildRentMarket(obs, { wards, floorPlan: c.floor_plan ?? null, rentMax: c.rent_max ?? null, pet: c.pet ?? null, label, maxAge: c.building_age ?? null });
    // 2026-10-02 ⑯ 手順3: 条件ごとの家賃（築年・駅徒歩・階・構造・広さ・設備の帯の中央値と差）と、予算の中の現実的な築年・面積（ブレイン・スタッフ向けの事実）
    const plan0 = wantedPlanGroups(c.floor_plan)[0];
    if (rm && plan0) {
      const area = label || wards.slice(0, 3).map((w) => w.replace(/^大阪市/, "")).join("・");
      rm.facts.push(...conditionMarketFacts(conditionMarket(obs as CondObs[], wards, plan0), area));
      if (c.rent_max) {
        const r = realisticWithinBudget(obs as CondObs[], wards, plan0, c.rent_max);
        if (r.sayable && (r.ageMedian != null || r.sqmMedian != null)) rm.facts.push(`${area}の${plan0}で${(c.rent_max / 10000).toFixed(1).replace(/\.0$/, "")}万以内（${r.n}件）の築年の中央値は${r.ageMedian ?? "-"}年・面積の中央値は${r.sqmMedian ?? "-"}㎡（検索の築年・広さの目安）`);
      }
    }
    // 2026-10-02 竹内さん「このような言い回しで」: 区の比べ（スタッフの言い回し・数字は今の材料）。主の区（範囲の駅の多い区／希望の1番目の区）と隣の区を同じ間取りで比べ、
    //   言ってよい線（両方10件以上・中央値の差0.5万以上・重なりの外）を越えた物だけ。事実には全部、お客様への文には「広げるとお安い」隣の区を1つだけ
    if (rm && plan0) {
      const main = wards[0];
      // 比べる区: 「出やすい・1本」の範囲がある人は範囲の中で「周辺」（3km）の外の区（＝希望を満たしたまま広げられる区・お客様に合う事が先）。無い人は隣の区
      const neighbors = plan
        ? plan.wards.map((w) => w.ward).filter((w) => !wards.includes(w)).slice(0, 8)
        : [...WARD_COORDS.keys()].filter((w) => w !== main && !wards.includes(w) && wardsAdjacent(main, w));
      if (neighbors.length) {
        const nobs = await loadRentObservations(neighbors);
        const all = [...obs, ...nobs];
        const cmps = neighbors.map((n) => ({ n, r: wardComparisonSentence(all, plan0, n, [main]) })).filter((x) => x.r) as Array<{ n: string; r: NonNullable<ReturnType<typeof wardComparisonSentence>> }>;
        cmps.sort((a, b) => b.r.cmp.gapYen - a.r.cmp.gapYen);
        for (const x of cmps) rm.facts.push(`区の比べ（${x.r.cmp.cheaper ? "安い" : "高い"}）: ${x.r.fact}｜文の候補「${x.r.sentence}」`);
        const widen = cmps.find((x) => x.r.cmp.cheaper);
        if (cmps.length) rm.wardComparisons = cmps.map((x) => ({ ward: x.n, base: main, cheaper: x.r.cmp.cheaper, gapYen: x.r.cmp.gapYen, sentence: x.r.sentence }));
        if (widen) rm.sentences.push(widen.r.sentence);
      }
    }
    return { areaPlan: plan, rentMarket: rm };
  } catch (e) {
    console.warn("[area-rent] 相場の読み込みに失敗:", e instanceof Error ? e.message : String(e));
    return { areaPlan: plan, rentMarket: null };
  }
}
