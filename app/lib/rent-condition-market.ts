// app/lib/rent-condition-market.ts（純関数・DB 依存なし）
// 「家賃と部屋の条件」の相場: 区×間取りの中で、築年・駅徒歩・階・構造・面積・主な設備の帯ごとの家賃の中央値と、全体の中央値との差。
// 黒箱にしない（帯の中央値と差だけ）。件数が RENT_EXPLAIN_RULE.minCount に満たない帯は数字を出さない。期間では切らない（竹内さん）。
//
// 2026-10-02 竹内「物件ピックアップで送る物件や物件オススメで送る物件から学べれるから、その家賃や築年数などお部屋の条件に対しての相場や、
//   知識がそこを強化していくようにする」
// 同日の訂正「べつに家賃が安いのがすべてではない。お客さんの希望の条件にどれだけあっているか。家賃が相場よりやすければ築年数が古いや、
//   構造が木造など、そういった部分がある。ちゃんと条件も踏まえたうえでお客さんに一番オススメの物件を見つけれるようになるかんがえ」
//   → 相場より安い事は加点にしない。安い・高い「理由」（古い・木造・駅から遠い・狭い・低い階・設備が無い）を出し、
//     その理由がこのお客様の希望に当たるか（tradeoffHits）を見るための材料。
import { RENT_EXPLAIN_RULE, percentile } from "./area-rent-explain";

export type CondObs = {
  ward: string | null; plan_group: string | null; rent_total: number | null;
  building_age?: number | null; walk_minutes?: number | null; floor?: number | null; structure?: string | null;
  area_sqm?: number | string | null; equipment?: Record<string, boolean> | null; usage_rank?: number | null;
};

export type Dim = "age" | "walk" | "floor" | "structure" | "sqm" | "autolock" | "bath_toilet" | "washbasin" | "delivery_box";
export const DIM_JA: Record<Dim, string> = {
  age: "築年", walk: "駅徒歩", floor: "階", structure: "構造", sqm: "広さ", autolock: "オートロック", bath_toilet: "バス・トイレ別", washbasin: "独立洗面台", delivery_box: "宅配BOX",
};

/** 帯の決まり（1か所） */
export const MARKET_BAND_RULE = {
  age: [[0, 5, "築5年以内"], [6, 15, "築6〜15年"], [16, 25, "築16〜25年"], [26, 999, "築26年以上"]] as Array<[number, number, string]>,
  walk: [[0, 5, "徒歩5分以内"], [6, 10, "徒歩6〜10分"], [11, 99, "徒歩11分以上"]] as Array<[number, number, string]>,
  floor: [[-9, 1, "1階"], [2, 4, "2〜4階"], [5, 999, "5階以上"]] as Array<[number, number, string]>,
  /** 面積は同じ区×間取りの中央値に対して ±15% */
  sqmRatio: 0.15,
  /** 理由に挙げる差（円）。これより小さい差は理由にしない */
  minDeltaYen: 3000,
} as const;

const num = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function structureBand(s: string | null | undefined): string | null {
  const t = String(s ?? "");
  if (!t) return null;
  if (/木/.test(t)) return "木造";
  if (/鉄骨|S造|軽量/.test(t) && !/鉄筋|RC|SRC/.test(t)) return "鉄骨造";
  if (/鉄筋|RC|SRC/.test(t)) return "鉄筋コンクリート造";
  return null;
}

/** 部屋1つの帯（読めない次元は null） */
export function bandsOf(o: CondObs, sqmMedian: number | null): Partial<Record<Dim, string | null>> {
  const pick = (v: number | null, table: ReadonlyArray<readonly [number, number, string]>) => (v == null ? null : table.find(([a, b]) => v >= a && v <= b)?.[2] ?? null);
  const sqm = num(o.area_sqm);
  let sqmBand: string | null = null;
  if (sqm != null && sqmMedian) sqmBand = sqm < sqmMedian * (1 - MARKET_BAND_RULE.sqmRatio) ? "狭め" : sqm > sqmMedian * (1 + MARKET_BAND_RULE.sqmRatio) ? "広め" : "標準";
  const eq = (k: string) => (o.equipment && k in o.equipment ? (o.equipment[k] ? "あり" : "なし") : null);
  return {
    age: pick(num(o.building_age), MARKET_BAND_RULE.age),
    walk: pick(num(o.walk_minutes), MARKET_BAND_RULE.walk),
    floor: pick(num(o.floor), MARKET_BAND_RULE.floor),
    structure: structureBand(o.structure),
    sqm: sqmBand,
    autolock: eq("autolock"), bath_toilet: eq("bath_toilet"), washbasin: eq("washbasin"), delivery_box: eq("delivery_box"),
  };
}

export type BandStat = { dim: Dim; band: string; n: number; median: number; delta: number; sayable: boolean };
export type ConditionMarket = { wards: string[]; plan: string; n: number; median: number | null; sqmMedian: number | null; bands: BandStat[] };

/** 区（まとめて）×間取りの「条件ごとの家賃」 */
export function conditionMarket(obs: CondObs[], wards: string[], plan: string): ConditionMarket {
  const rows = obs.filter((o) => o.rent_total != null && o.plan_group === plan && (!wards.length || (o.ward != null && wards.includes(o.ward))));
  const rents = rows.map((o) => o.rent_total as number).sort((a, b) => a - b);
  const sqms = rows.map((o) => num(o.area_sqm)).filter((v): v is number => v != null && v > 5).sort((a, b) => a - b);
  const median = rents.length ? Math.round(percentile(rents, 0.5)) : null;
  const sqmMedian = sqms.length ? Math.round(percentile(sqms, 0.5) * 10) / 10 : null;
  const groups = new Map<string, number[]>();
  for (const o of rows) {
    for (const [dim, band] of Object.entries(bandsOf(o, sqmMedian)) as Array<[Dim, string | null]>) {
      if (!band) continue;
      const k = `${dim}|${band}`;
      const a = groups.get(k) ?? [];
      a.push(o.rent_total as number);
      groups.set(k, a);
    }
  }
  const bands: BandStat[] = [];
  for (const [k, xs] of groups) {
    const [dim, band] = k.split("|") as [Dim, string];
    xs.sort((a, b) => a - b);
    const m = Math.round(percentile(xs, 0.5));
    bands.push({ dim, band, n: xs.length, median: m, delta: median != null ? m - median : 0, sayable: xs.length >= RENT_EXPLAIN_RULE.minCount });
  }
  bands.sort((a, b) => a.dim.localeCompare(b.dim) || b.n - a.n);
  return { wards, plan, n: rows.length, median, sqmMedian, bands };
}

export type GapReason = { dim: Dim; band: string; delta: number; label: string };
export type RentGap = { gapYen: number; median: number; reasons: GapReason[] };

/**
 * 部屋の家賃が相場（区×間取りの中央値）からどれだけ離れているかと、その理由（同じ向きに差のある帯・件数が足りる帯だけ）。
 * 安い事そのものは良い・悪いを言わない（理由を並べるだけ）
 */
export function explainGap(o: CondObs, m: ConditionMarket): RentGap | null {
  if (o.rent_total == null || m.median == null || m.n < RENT_EXPLAIN_RULE.minCount) return null;
  const gap = o.rent_total - m.median;
  const reasons: GapReason[] = [];
  for (const [dim, band] of Object.entries(bandsOf(o, m.sqmMedian)) as Array<[Dim, string | null]>) {
    if (!band) continue;
    const b = m.bands.find((x) => x.dim === dim && x.band === band);
    if (!b || !b.sayable || Math.abs(b.delta) < MARKET_BAND_RULE.minDeltaYen) continue;
    if (Math.sign(b.delta) !== Math.sign(gap) || gap === 0) continue;
    reasons.push({ dim, band, delta: b.delta, label: `${DIM_JA[dim]}: ${band}（この帯の中央値は相場より${Math.abs(Math.round(b.delta / 1000))}千円${b.delta < 0 ? "安い" : "高い"}・${b.n}件）` });
  }
  reasons.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { gapYen: gap, median: m.median, reasons };
}

/** お客様の希望（決定論で読んだ物）。true＝その希望がある */
export type TradeoffWants = { newBuild?: boolean; maxAge?: number | null; notWood?: boolean; soundproof?: boolean; walkMax?: number | null; minSqm?: number | null; floor2?: boolean; autolock?: boolean; bathToilet?: boolean; washbasin?: boolean; deliveryBox?: boolean };

/**
 * 安い理由のうち、このお客様の希望に当たる物（「古い」は築浅・築年の上限を言った人に、「木造」は木造NG・防音を言った人に…）。
 * 当たらない理由は、このお客様には問題になりにくい（予算と場所だけ気にする人には古くても良い）
 */
export function tradeoffHits(gap: RentGap | null, o: CondObs, w: TradeoffWants): GapReason[] {
  if (!gap) return [];
  const age = num(o.building_age), walk = num(o.walk_minutes), sqm = num(o.area_sqm), fl = num(o.floor);
  return gap.reasons.filter((r) => {
    if (r.delta >= 0) return false;
    switch (r.dim) {
      case "age": return (!!w.newBuild && age != null && age > 5) || (w.maxAge != null && age != null && age > w.maxAge);
      case "structure": return (!!w.notWood || !!w.soundproof) && r.band !== "鉄筋コンクリート造";
      case "walk": return w.walkMax != null && walk != null && walk > w.walkMax;
      case "sqm": return w.minSqm != null && sqm != null && sqm < w.minSqm;
      case "floor": return !!w.floor2 && fl != null && fl < 2;
      case "autolock": return !!w.autolock && r.band === "なし";
      case "bath_toilet": return !!w.bathToilet && r.band === "なし";
      case "washbasin": return !!w.washbasin && r.band === "なし";
      case "delivery_box": return !!w.deliveryBox && r.band === "なし";
      default: return false;
    }
  });
}

/** 予算の中で現実的な築年・面積（検索の目安）: 予算以内の部屋の築年・面積の中央値 */
export function realisticWithinBudget(obs: CondObs[], wards: string[], plan: string, budgetYen: number): { n: number; ageMedian: number | null; sqmMedian: number | null; sayable: boolean } {
  const rows = obs.filter((o) => o.rent_total != null && (o.rent_total as number) <= budgetYen && o.plan_group === plan && (!wards.length || (o.ward != null && wards.includes(o.ward))));
  const ages = rows.map((o) => num(o.building_age)).filter((v): v is number => v != null).sort((a, b) => a - b);
  const sqms = rows.map((o) => num(o.area_sqm)).filter((v): v is number => v != null && v > 5).sort((a, b) => a - b);
  return {
    n: rows.length,
    ageMedian: ages.length >= RENT_EXPLAIN_RULE.minCount ? Math.round(percentile(ages, 0.5)) : null,
    sqmMedian: sqms.length >= RENT_EXPLAIN_RULE.minCount ? Math.round(percentile(sqms, 0.5) * 10) / 10 : null,
    sayable: rows.length >= RENT_EXPLAIN_RULE.minCount,
  };
}

/** ブレイン・スタッフ向けの事実の行（お客様への文ではない） */
export function conditionMarketFacts(m: ConditionMarket, label: string, max = 6): string[] {
  if (m.median == null || m.n < RENT_EXPLAIN_RULE.minCount) return [];
  const out: string[] = [];
  const say = m.bands.filter((b) => b.sayable && Math.abs(b.delta) >= MARKET_BAND_RULE.minDeltaYen).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, max);
  for (const b of say) out.push(`${label}の${m.plan}で${b.band}（${DIM_JA[b.dim]}）は中央値${(b.median / 10000).toFixed(1)}万＝全体（${(m.median / 10000).toFixed(1)}万）より${Math.abs(Math.round(b.delta / 1000))}千円${b.delta < 0 ? "安い" : "高い"}（${b.n}件）`);
  return out;
}
