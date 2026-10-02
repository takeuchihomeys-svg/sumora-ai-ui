// app/lib/area-rent-explain.ts（純関数・DB 依存なし）
// 家賃の相場の材料（DB rent_observations の管理費込みの家賃）から、ブレイン・スタッフ向けの事実と、お客様に送れる文を作る。
//
// 2026-10-02 竹内「大阪市内中心に区域の関係や、家賃相場（条件によった）調べるし、物件送ってる条件から、相場感等もたまっていくので、そこも貯めていく」
//   松浦さん 10/2「ペットおっけ、8.5までの家賃で1dkはやっぱりないですよね💦」に答える材料が無かった（返信は「探します」）。
//
// ■ 竹内さんの決定（2026-10-02）
//   ・期間で切らない（「家賃はそんなに変わらない」）＝ためた全部を使う
//   ・お客様に数字を言うのは件数 RENT_EXPLAIN_RULE.minCount 以上・0.5万円で丸める
// ■ 文はスタッフが実際に送った型だけ（メモリ feedback_no_invented_phrases・新しい言い回しを作らない）
//   出典（messages.sender=staff・直近90日で「相場」を含む7通から）:
//   S1「大阪市北区の1LDKの家賃相場は9万円から12万円程となります！！」
//      「桜ノ宮、都島駅周辺の2LDKの家賃相場は13万円からとなります！！」
//   S2「7万円ですと1Kの家賃相場程ですので、間取りやご希望のエリア広げれましたら追加でオススメできるお部屋ピックアップ可能です😊！！」
// ■ 偏りの注意: 材料は「各お客様の条件で検索して見つかった物件」＝市場全体ではない（家賃の上限で切られている）。
//   スタッフの文（難波周辺の1K 7〜8万）と浪速区の1K の 25〜75%（7.0〜8.0万）は合う。1LDK はこちらが高めに出る。

export const RENT_EXPLAIN_RULE = {
  /** お客様に数字を言う最小の件数（竹内さん 2026-10-02） */
  minCount: 10,
  /** 丸めの単位（万円） */
  roundMan: 0.5,
  /** 「◯◯周辺の」相場に数える区＝基準の駅から直線この km 以内の駅がある区（⑯の仮の線・竹内さんの確認待ち） */
  coreKm: 3,
} as const;

/** 間取りのまとまり（DB の rent_plan_group と同じ） */
export type PlanGroup = "1K" | "1DK" | "1LDK" | "2DK" | "2LDK" | "3+";
const PLAN_ORDER: PlanGroup[] = ["1K", "1DK", "1LDK", "2DK", "2LDK", "3+"];

/** 間取りの書き方 → まとまり（DB の rent_plan_group と同じ線） */
export function planGroupOf(plan: string | null | undefined): PlanGroup | null {
  const p = String(plan ?? "").normalize("NFKC").toUpperCase().replace(/\s/g, "");
  if (!p) return null;
  if (/^(1R|1K|1SK|ワンルーム)$/.test(p)) return "1K";
  if (/^1S?DK$/.test(p)) return "1DK";
  if (/^1S?LDK$/.test(p)) return "1LDK";
  if (/^2S?(K|DK)$/.test(p)) return "2DK";
  if (/^2S?LDK$/.test(p)) return "2LDK";
  if (/^[3-9]/.test(p)) return "3+";
  return null;
}

/** 顧客の間取りの欄（「1DK・1K」「1dkが希望。最悪1k」）の最初のまとまり */
export function wantedPlanGroups(floorPlan: string | null | undefined): PlanGroup[] {
  const t = String(floorPlan ?? "").normalize("NFKC").toUpperCase();
  const out: PlanGroup[] = [];
  for (const m of t.matchAll(/[1-9]S?(?:LDK|DK|K|R)|ワンルーム/g)) {
    const g = planGroupOf(m[0]);
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}

export type RentObs = { ward: string | null; plan_group: string | null; rent_total: number | null; pet?: boolean | null };

/** 分位（線形補間・percentile_cont と同じ） */
export function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** 円 → 万（0.5 刻み・下は切り下げ／上は切り上げ） */
export function roundManDown(yen: number): number { const u = RENT_EXPLAIN_RULE.roundMan; return Math.floor(yen / 10000 / u) * u; }
export function roundManUp(yen: number): number { const u = RENT_EXPLAIN_RULE.roundMan; return Math.ceil(yen / 10000 / u) * u; }
const manStr = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export type RentBand = { plan: PlanGroup; n: number; p25: number; p50: number; p75: number; lo: number; hi: number; nWithinBudget: number | null; sayable: boolean };

/** 区の一覧×間取りのまとまりの相場（区をまとめて数える） */
export function rentBand(obs: RentObs[], wards: string[], plan: PlanGroup, budgetYen?: number | null, opts: { pet?: boolean } = {}): RentBand | null {
  const xs = obs
    .filter((o) => o.rent_total != null && o.plan_group === plan && (!wards.length || (o.ward != null && wards.includes(o.ward))) && (opts.pet == null || o.pet === opts.pet))
    .map((o) => o.rent_total as number)
    .sort((a, b) => a - b);
  if (!xs.length) return null;
  const p25 = percentile(xs, 0.25), p50 = percentile(xs, 0.5), p75 = percentile(xs, 0.75);
  return {
    plan, n: xs.length, p25: Math.round(p25), p50: Math.round(p50), p75: Math.round(p75),
    lo: roundManDown(p25), hi: roundManUp(p75),
    nWithinBudget: budgetYen ? xs.filter((v) => v <= budgetYen).length : null,
    sayable: xs.length >= RENT_EXPLAIN_RULE.minCount,
  };
}

export type RentMarket = {
  /** ブレイン・スタッフ向けの事実（お客様には送らない） */
  facts: string[];
  /** お客様に送れる文（スタッフの実際の型だけ・件数が足りる時だけ） */
  sentences: string[];
  bands: RentBand[];
};

const shortWard = (w: string) => w.replace(/^大阪市/, "");

/**
 * 希望の区（area_plan の区・希望の区）と希望の間取りの相場。
 * label: 文の「◯◯周辺の」の◯◯（「なんば・梅田」）。無ければ区の名前を「・」で並べる
 */
export function buildRentMarket(obs: RentObs[], input: { wards: string[]; floorPlan: string | null; rentMax: number | null; pet?: boolean | null; label?: string | null }): RentMarket | null {
  const plans = wantedPlanGroups(input.floorPlan);
  if (!input.wards.length || !plans.length) return null;
  const facts: string[] = [];
  const sentences: string[] = [];
  const bands: RentBand[] = [];
  const area = input.label || input.wards.slice(0, 3).map(shortWard).join("・");
  const main = plans[0];
  const b = rentBand(obs, input.wards, main, input.rentMax);
  if (!b) return { facts: [`${area}の${main}: 当社の検索で見つかった物件の記録なし`], sentences: [], bands: [] };
  bands.push(b);
  facts.push(`${area}の${main}（管理費込み・当社の検索で見つかった${b.n}件・期間の区切りなし）: 中央値${manStr(Math.round(b.p50 / 1000) / 10)}万・25〜75%は${manStr(Math.round(b.p25 / 1000) / 10)}〜${manStr(Math.round(b.p75 / 1000) / 10)}万${b.nWithinBudget != null && input.rentMax ? `・${manStr(input.rentMax / 10000)}万以内は${b.nWithinBudget}件` : ""}${b.sayable ? "" : `（${RENT_EXPLAIN_RULE.minCount}件未満のためお客様には言わない）`}`);
  // 区ごとの内訳（予算以内の件数）
  if (input.rentMax) {
    const perWard = input.wards
      .map((w) => ({ w, n: obs.filter((o) => o.ward === w && o.plan_group === main && o.rent_total != null && (o.rent_total as number) <= (input.rentMax as number)).length }))
      .filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
    if (perWard.length) facts.push(`${main}で${manStr(input.rentMax / 10000)}万以内が見つかった区: ${perWard.slice(0, 8).map((x) => `${shortWard(x.w)}${x.n}`).join("・")}`);
  }
  if (input.pet) {
    const petN = obs.filter((o) => o.pet === true && o.plan_group === main && o.ward != null && input.wards.includes(o.ward)).length;
    facts.push(`ペット可（相談含む）と資料で分かる${main}: ${petN}件（ペット可の相場は件数が少ないため言わない）`);
  }
  if (b.sayable) sentences.push(`${area}周辺の${main}の家賃相場は${manStr(b.lo)}万円から${manStr(b.hi)}万円程となります！！`);
  // 予算が希望の間取りの相場の下にある時: 予算が相場に入る小さい間取り（S2 の型）
  if (input.rentMax && b.sayable && input.rentMax < b.p25) {
    const idx = PLAN_ORDER.indexOf(main);
    for (let i = idx - 1; i >= 0; i--) {
      const sb = rentBand(obs, input.wards, PLAN_ORDER[i], input.rentMax);
      if (!sb || !sb.sayable) continue;
      bands.push(sb);
      facts.push(`${area}の${sb.plan}（${sb.n}件）: 25〜75%は${manStr(Math.round(sb.p25 / 1000) / 10)}〜${manStr(Math.round(sb.p75 / 1000) / 10)}万`);
      if (input.rentMax >= sb.p25 && input.rentMax <= sb.p75 * 1.1) {
        sentences.push(`${manStr(input.rentMax / 10000)}万円ですと${sb.plan}の家賃相場程ですので、間取りやご希望のエリア広げれましたら追加でオススメできるお部屋ピックアップ可能です😊！！`);
      }
      break;
    }
  }
  return { facts, sentences, bands };
}
