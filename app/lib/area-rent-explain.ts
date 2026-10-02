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
  /** 「◯◯周辺の」相場に数える区＝基準の駅から直線この km 以内の駅がある区（2026-10-02 竹内さん決定） */
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

export type RentObs = { ward: string | null; plan_group: string | null; rent_total: number | null; pet?: boolean | null; building_age?: number | null; walk_minutes?: number | null; floor?: number | null; structure?: string | null; area_sqm?: number | string | null; equipment?: Record<string, boolean> | null };

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
  /** 2026-10-02 予算の中の目安（築年・広さ・築年の傾向）。無ければ null */
  budgetTypical?: BudgetTypical | null;
  /** 2026-10-02 区の比べ（隣の区・同じ間取り・言ってよい線を越えた物） */
  wardComparisons?: Array<{ ward: string; base: string; cheaper: boolean; gapYen: number; sentence: string }>;
};

const shortWard = (w: string) => w.replace(/^大阪市/, "");

/**
 * 希望の区（area_plan の区・希望の区）と希望の間取りの相場。
 * label: 文の「◯◯周辺の」の◯◯（「なんば・梅田」）。無ければ区の名前を「・」で並べる
 */
export function buildRentMarket(obs: RentObs[], input: { wards: string[]; floorPlan: string | null; rentMax: number | null; pet?: boolean | null; label?: string | null; maxAge?: number | null }): RentMarket | null {
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
  // 2026-10-02 竹内さん: 予算の中の目安（築年は10年刻みの「築30年程」・広さは5㎡刻みの「25〜30㎡程」・古め／築浅めの要約）
  const bt = input.rentMax ? budgetTypical(obs, input.wards, main, input.rentMax) : null;
  if (bt) {
    facts.push(`${manStr((input.rentMax as number) / 10000)}万円以内の${main}（${bt.n}件）: 築年の中央値${bt.ageMedian}年（この区×間取り全体は${bt.overallAgeMedian}年）・面積の25〜75%は${bt.sqmP25}〜${bt.sqmP75}㎡・築年の傾向 ${bt.ageTendency ?? "なし"}`);
    sentences.push(bt.sentence);
  }
  // 2026-10-02 ⑯ 手順3: 築年の希望（築浅・築N年以内）がある人は、その築年の中の相場も（S1 の型の「周辺の」と「間取り」の間に築年を入れるだけ）
  if (input.maxAge != null && input.maxAge > 0) {
    const young = obs.filter((o) => o.building_age != null && (o.building_age as number) <= (input.maxAge as number));
    const yb = rentBand(young, input.wards, main, input.rentMax);
    if (yb) {
      bands.push(yb);
      facts.push(`${area}の築${input.maxAge}年以内の${main}（${yb.n}件）: 中央値${manStr(Math.round(yb.p50 / 1000) / 10)}万・25〜75%は${manStr(Math.round(yb.p25 / 1000) / 10)}〜${manStr(Math.round(yb.p75 / 1000) / 10)}万${yb.nWithinBudget != null && input.rentMax ? `・${manStr(input.rentMax / 10000)}万以内は${yb.nWithinBudget}件` : ""}${yb.sayable ? "" : `（${RENT_EXPLAIN_RULE.minCount}件未満のためお客様には言わない）`}`);
      if (yb.sayable) sentences.push(`${area}周辺の築${input.maxAge}年以内の${main}の家賃相場は${manStr(yb.lo)}万円から${manStr(yb.hi)}万円程となります！！`);
    }
  }
  return { facts, sentences, bands, budgetTypical: bt };
}

// ───────────────────────── 予算の中の目安（築年・広さ・傾向） ─────────────────────────
// 2026-10-02 竹内さん「38年と限定しすぎずに 築30年程や 25～30㎡といれるとわかりやすい 特定しすぎたら逆に相場ではない」
//   「この場合要約したら築年数古めとなるってことをちゃんとお客さんに伝えるようにする」
//   築年: 中央値を10年刻みで切り下げ「築30年程」（10年未満は「築10年以内」）／広さ: 25〜75% を5㎡刻みで外へ丸め「25〜30㎡程」（幅が15㎡を超えたら出さない）
//   傾向: 予算の中の築年の中央値が BUDGET_TYPICAL_RULE.oldAge 年以上か、区×間取り全体の中央値より oldGap 年以上古い→「古め」／
//         全体より newGap 年以上新しく newAgeMax 年以下→「築浅め」／それ以外は言わない。件数は RENT_EXPLAIN_RULE.minCount 以上
export const BUDGET_TYPICAL_RULE = { oldAge: 25, oldGap: 10, newGap: 10, newAgeMax: 10, maxSqmWidth: 15 } as const;
export type BudgetTypical = { n: number; ageMedian: number; overallAgeMedian: number; sqmP25: number; sqmP75: number; ageText: string; sqmText: string; ageTendency: "old" | "new" | null; sentence: string };

export function budgetTypical(obs: RentObs[], wards: string[], plan: PlanGroup, budgetYen: number): BudgetTypical | null {
  const inArea = obs.filter((o) => o.plan_group === plan && (!wards.length || (o.ward != null && wards.includes(o.ward))));
  const rows = inArea.filter((o) => o.rent_total != null && (o.rent_total as number) <= budgetYen);
  const ages = rows.map((o) => o.building_age).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  const sqms = rows.map((o) => Number(o.area_sqm)).filter((v) => Number.isFinite(v) && v > 5).sort((a, b) => a - b);
  const allAges = inArea.map((o) => o.building_age).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  if (ages.length < RENT_EXPLAIN_RULE.minCount || sqms.length < RENT_EXPLAIN_RULE.minCount || !allAges.length) return null;
  const ageMedian = Math.round(percentile(ages, 0.5));
  const overallAgeMedian = Math.round(percentile(allAges, 0.5));
  const sqmP25 = Math.floor(percentile(sqms, 0.25) / 5) * 5;
  const sqmP75 = Math.ceil(percentile(sqms, 0.75) / 5) * 5;
  if (sqmP75 - sqmP25 > BUDGET_TYPICAL_RULE.maxSqmWidth) return null;
  const ageText = ageMedian < 10 ? "築10年以内" : `築${Math.floor(ageMedian / 10) * 10}年程`;
  const sqmText = sqmP75 > sqmP25 ? `${sqmP25}〜${sqmP75}㎡程` : `${sqmP25}㎡程`;
  const ageTendency: BudgetTypical["ageTendency"] =
    ageMedian >= BUDGET_TYPICAL_RULE.oldAge || ageMedian - overallAgeMedian >= BUDGET_TYPICAL_RULE.oldGap ? "old"
    : overallAgeMedian - ageMedian >= BUDGET_TYPICAL_RULE.newGap && ageMedian <= BUDGET_TYPICAL_RULE.newAgeMax ? "new" : null;
  const b = manStr(budgetYen / 10000);
  const sentence = ageTendency
    ? `${b}万円以内の${plan}ですと築年数は${ageTendency === "old" ? "古め" : "浅め"}のお部屋が中心となり、${ageText}・${sqmText}が目安となります！！`
    : `${b}万円以内の${plan}ですと、${ageText}・${sqmText}のお部屋が中心となります！！`;
  return { n: rows.length, ageMedian, overallAgeMedian, sqmP25, sqmP75, ageText, sqmText, ageTendency, sentence };
}

// ───────────────────────── 区・駅のまわりの比べ（スタッフの言い回し・数字は今の材料から） ─────────────────────────
// 2026-10-02 竹内さん「このような言い回しで」（スタッフの過去の文: 「西成区は…中央区・浪速区と比べて2万円〜3万円程お安くなります」
//   「福島駅周辺は野田駅周辺よりも家賃相場高いエリアとなります」「大阪梅田駅まで乗り換え無し20分〜25分程でアクセス可能です」）。
//   言い回しだけを使い、数字と向きは今の rent_observations（同じ間取り）から出す。古い文の数字は使わない。
// ■ 言ってよい線（COMPARE_RULE）: 両方とも件数 10 以上・中央値の差 0.5万以上・かつ片方の中央値がもう片方の 25〜75% の外（重なりの中なら言わない）
export const COMPARE_RULE = { minCount: RENT_EXPLAIN_RULE.minCount, minGapYen: 5000 } as const;

type Stat = { n: number; p25: number; p50: number; p75: number };
function statOf(xs: number[]): Stat | null {
  if (xs.length < COMPARE_RULE.minCount) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p25: percentile(s, 0.25), p50: percentile(s, 0.5), p75: percentile(s, 0.75) };
}
const shortW = (w: string) => w.replace(/^大阪市/, "");

export type Comparison = { cheaper: boolean; gapYen: number; lo: number; hi: number; a: Stat; b: Stat };
/** a（比べる側）と b（比べられる側）の差。言ってよい線を越えない時は null */
export function compareRents(aRents: number[], bRents: number[]): Comparison | null {
  const a = statOf(aRents), b = statOf(bRents);
  if (!a || !b) return null;
  const gap = b.p50 - a.p50; // 正＝a の方が安い
  if (Math.abs(gap) < COMPARE_RULE.minGapYen) return null;
  const outside = gap > 0 ? a.p50 < b.p25 || b.p50 > a.p75 : a.p50 > b.p75 || b.p50 < a.p25;
  if (!outside) return null;
  const diffs = [Math.abs(b.p25 - a.p25), Math.abs(gap), Math.abs(b.p75 - a.p75)].sort((x, y) => x - y);
  let lo = roundManDown(diffs[0]), hi = roundManUp(diffs[2]);
  if (lo < 0.5) lo = 0.5;
  if (hi < lo) hi = lo;
  return { cheaper: gap > 0, gapYen: Math.round(gap), lo, hi, a, b };
}

/** 「{A区}は{B区}・{C区}と比べて{x}万円〜{y}万円程お安く（高く）なります！！」 */
export function wardComparisonSentence(obs: RentObs[], plan: PlanGroup, ward: string, others: string[]): { sentence: string; fact: string; cmp: Comparison } | null {
  const rentsOf = (ws: string[]) => obs.filter((o) => o.plan_group === plan && o.rent_total != null && o.ward != null && ws.includes(o.ward)).map((o) => o.rent_total as number);
  const cmp = compareRents(rentsOf([ward]), rentsOf(others));
  if (!cmp) return null;
  const range = cmp.hi > cmp.lo ? `${manStr(cmp.lo)}万円〜${manStr(cmp.hi)}万円` : `${manStr(cmp.lo)}万円`;
  const sentence = `${shortW(ward)}は${others.map(shortW).join("・")}と比べて${range}程${cmp.cheaper ? "お安く" : "高く"}なります！！`;
  const fact = `${plan}: ${shortW(ward)} 中央値${manStr(Math.round(cmp.a.p50 / 1000) / 10)}万（${cmp.a.n}件）／${others.map(shortW).join("・")} 中央値${manStr(Math.round(cmp.b.p50 / 1000) / 10)}万（${cmp.b.n}件）`;
  return { sentence, fact, cmp };
}

/** 「{X}駅周辺は{Y}駅周辺よりも家賃相場高い（お安い）エリアとなります！！」（station＝rent_observations.station のまとまり） */
export function stationComparisonSentence(obs: Array<RentObs & { station?: string | null }>, plan: PlanGroup, x: string, y: string, groupOf: (s: string) => string): { sentence: string; cmp: Comparison } | null {
  const rentsAt = (st: string) => obs.filter((o) => o.plan_group === plan && o.rent_total != null && o.station && groupOf(o.station) === st).map((o) => o.rent_total as number);
  const cmp = compareRents(rentsAt(x), rentsAt(y));
  if (!cmp) return null;
  return { sentence: `${x}駅周辺は${y}駅周辺よりも家賃相場${cmp.cheaper ? "お安い" : "高い"}エリアとなります！！`, cmp };
}

/** 「{X}駅まで乗り換え無し{a}分〜{b}分程でアクセス可能です！！」（分は5分刻みの幅・乗り換えありは「乗り換え{n}回で」） */
export function accessSentence(target: string, minutes: number, transfers: number): string {
  const a = Math.max(5, Math.floor(minutes / 5) * 5), b = a + 5;
  return `${target}駅まで${transfers === 0 ? "乗り換え無し" : `乗り換え${transfers}回で`}${a}分〜${b}分程でアクセス可能です！！`;
}
