// app/lib/customer-pattern-weights.ts（純関数・DB/LLM なし・画面とサーバーで共用できる）
// お客様の型（customer-pattern.ts の patternKey）ごとに「その型のスタッフが選ぶ特徴」へ足し点を付ける表と、その表を回から学ぶ関数。
//
// 2026-10-06 竹内「パターンによって採点基準パターンかえているか…分析力上げるため」
//   scripts/audit-customer-pattern.ts で、型ごとにスタッフの選び方（送った物・🌟）が他の型と違う特徴を測り、
//   前7割で表を作って後3割で旧/新の1位一致を比べる。下がる・回数の少ない型の行は入れない。
//
// ■ 決めたこと（動かさない所）
//   ・加点だけ（減点しない）・1つ points 点・合計 maxTotal まで（AD の線 15点＝AD2ヶ月の札÷1.45 を超えない）
//   ・学ばない特徴: AD（竹内さんの方針で決まる）・家賃の安さ（rent_low・rent_lowest＝「安いほど良い」は加点しない・feedback_fit_first_not_cheap）
//   ・型の行に入れるのは「その型で選んだ方が持つ率が 50% から z≥minZ 離れ」かつ「他の型と minDiff 以上違う（差の z≥minDiffZ）」物だけ。
//     全員で同じ向きの物は型の行に入れない（globalOnly の時だけ「全体」の行に入れる＝比べる案）
//   ・表が空なら何も変わらない。呼ぶ側は表と型を渡すだけ
import { isHouseholdType, type CustomerPattern } from "./customer-pattern";

export type PatternFeature =
  | "rent_upper" | "rent_low" | "zero_zero" | "walk_near" | "age_new" | "age_old" | "area_wide" | "ad_high" | "floor_high" | "plan_match" | "rc"
  | "area_best" | "age_best" | "walk_best" | "rent_highest" | "rent_lowest";
export const PATTERN_FEATURE_JA: Record<PatternFeature, string> = {
  rent_upper: "家賃が上限の9割〜1.1倍", rent_low: "家賃が上限の8割未満", zero_zero: "敷礼0", walk_near: "駅徒歩7分以内", age_new: "築15年以内", age_old: "築30年以上",
  area_wide: "広い（一人25㎡・二人以上40㎡以上）", ad_high: "AD2ヶ月以上", floor_high: "2階以上", plan_match: "間取りが本命に一致", rc: "RC・SRC",
  area_best: "束で一番広い", age_best: "束で一番新しい", walk_best: "束で一番駅近", rent_highest: "束で一番家賃が高い", rent_lowest: "束で一番家賃が安い",
};
export const PATTERN_FEATURES = Object.keys(PATTERN_FEATURE_JA) as PatternFeature[];
/** 学ぶ特徴（AD・家賃の安さは学ばない） */
export const LEARNABLE_FEATURES: readonly PatternFeature[] = PATTERN_FEATURES.filter((f) => !["ad_high", "rent_low", "rent_lowest"].includes(f));

export type PatternFeatureInput = {
  rentRatio?: number | null; areaSqm?: number | null; buildingAge?: number | null; walk?: number | null; zeroZero?: number | boolean | null;
  adMonths?: number | null; floor?: number | null; planMatch?: number | null; equipmentCount?: number | null; structure?: string | null;
};
/** 束の中の比べ（呼ぶ側が束の候補から作る・値が割れていない項目は null） */
export type BundleContext = { maxArea?: number | null; minAge?: number | null; minWalk?: number | null; maxRent?: number | null; minRent?: number | null };

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const b = (v: boolean | null): 0 | 1 | null => (v == null ? null : v ? 1 : 0);

export function patternFeatureBits(x: PatternFeatureInput, p: Pick<CustomerPattern, "household">, bundle?: BundleContext | null): Partial<Record<PatternFeature, 0 | 1 | null>> {
  const r = n(x.rentRatio), a = n(x.areaSqm), age = n(x.buildingAge), w = n(x.walk), ad = n(x.adMonths), fl = n(x.floor), pm = n(x.planMatch);
  const z = typeof x.zeroZero === "boolean" ? (x.zeroZero ? 1 : 0) : n(x.zeroZero);
  const st = String(x.structure ?? "");
  const out: Partial<Record<PatternFeature, 0 | 1 | null>> = {
    rent_upper: b(r == null ? null : r >= 0.9 && r <= 1.1),
    rent_low: b(r == null ? null : r < 0.8),
    zero_zero: b(z == null ? null : z === 1),
    walk_near: b(w == null ? null : w <= 7),
    age_new: b(age == null ? null : age <= 15),
    age_old: b(age == null ? null : age >= 30),
    area_wide: b(a == null ? null : a >= (isHouseholdType(p.household) ? 40 : 25)),
    ad_high: b(ad == null ? null : ad >= 2),
    floor_high: b(fl == null ? null : fl >= 2),
    plan_match: b(pm == null ? null : pm === 2),
    rc: b(st ? /^(RC|SRC)$/.test(st) : null),
  };
  if (bundle) {
    out.area_best = b(a == null || bundle.maxArea == null ? null : a === bundle.maxArea);
    out.age_best = b(age == null || bundle.minAge == null ? null : age === bundle.minAge);
    out.walk_best = b(w == null || bundle.minWalk == null ? null : w === bundle.minWalk);
    out.rent_highest = b(r == null || bundle.maxRent == null ? null : r === bundle.maxRent);
    out.rent_lowest = b(r == null || bundle.minRent == null ? null : r === bundle.minRent);
  }
  return out;
}

// ─── 型の鍵（どの軸で分けるか）───────────────────────────────────────────
/**
 * 1人のお客様が属する型の鍵（軸ごとに1つずつ・重視点は重なる）。表はこの鍵で引く。
 *   型:<patternKey>・世帯:<household>・予算:<budget>・重視:<focus>・急ぎ:<urgency>・段:<stage>（段は会話の数えが要る・無ければ付けない）
 */
export function patternGroupKeys(p: CustomerPattern, conv?: { stage?: string | null; bringsOwn?: boolean | null } | null): string[] {
  const keys = [`型:${p.patternKey}`, `世帯:${p.household}`, `予算:${p.budget}`, `急ぎ:${p.urgency}`, ...p.focus.map((f) => `重視:${f}`)];
  if (conv?.stage) keys.push(`段:${conv.stage}`);
  if (conv?.bringsOwn) keys.push("持ち込み");
  return keys;
}

/** 型の鍵 → 足す特徴と点。「全体」は全員（比べる案のときだけ使う） */
export type PatternBonusRow = { f: PatternFeature; points: number; n: number; win: number; others?: number };
export type PatternBonusTable = Record<string, PatternBonusRow[]>;

export const PATTERN_BONUS_CONFIG = {
  /** 1つの点 */
  points: 10,
  /** 合計の上限（AD の線 15点を超えない） */
  maxTotal: 15,
  /** その型で特徴が割れた回の最低数 */
  minEpisodes: 15,
  /** 50% からの離れ（z） */
  minZ: 2.0,
  /** 他の型との差（率）と差の z */
  minDiff: 0.1,
  minDiffZ: 1.5,
  /** true＝型を見ず「全体」の行だけ作る（比べる案） */
  globalOnly: false,
} as const;
export type PatternBonusConfig = { points: number; maxTotal: number; minEpisodes: number; minZ: number; minDiff: number; minDiffZ: number; globalOnly: boolean };

/** 足し点（表が無ければ 0）。keys はお客様の型の鍵（patternGroupKeys）。同じ特徴は1回だけ */
export function patternBonusOf(
  table: PatternBonusTable | null | undefined, keys: readonly string[], p: Pick<CustomerPattern, "household">, x: PatternFeatureInput,
  bundle?: BundleContext | null, cfg: Pick<PatternBonusConfig, "maxTotal"> = PATTERN_BONUS_CONFIG,
): { points: number; hits: string[] } {
  if (!table) return { points: 0, hits: [] };
  return patternBonusOfBits(table, keys, patternFeatureBits(x, p, bundle), cfg);
}
export function patternBonusOfBits(table: PatternBonusTable | null | undefined, keys: readonly string[], bits: Partial<Record<PatternFeature, 0 | 1 | null>>, cfg: Pick<PatternBonusConfig, "maxTotal"> = PATTERN_BONUS_CONFIG): { points: number; hits: string[] } {
  if (!table) return { points: 0, hits: [] };
  const want = ["全体", ...keys].flatMap((k) => table[k] ?? []);
  const seen = new Set<string>(); let pts = 0; const hits: string[] = [];
  for (const w of want) {
    if (seen.has(w.f)) continue; seen.add(w.f);
    if (bits[w.f] === 1) { pts += w.points; hits.push(PATTERN_FEATURE_JA[w.f]); }
  }
  return { points: Math.min(cfg.maxTotal, pts), hits };
}

// ─── 学ぶ ────────────────────────────────────────────────────────────────────
export type PatternEpisode = { id: string; at: string; keys: string[]; cands: Array<{ chosen: boolean; bits: Partial<Record<PatternFeature, 0 | 1 | null>> }> };

/** 回の中で「選んだ方が特徴を持つ率」（持つ／持たないが割れた組だけ・無ければ null） */
export function episodeFeatureWin(e: Pick<PatternEpisode, "cands">, f: PatternFeature): number | null {
  let w = 0, k = 0;
  for (const a of e.cands) if (a.chosen) for (const c of e.cands) if (!c.chosen) {
    const x = a.bits[f], y = c.bits[f];
    if (x == null || y == null || x === y) continue;
    w += x; k++;
  }
  return k ? w / k : null;
}
const mean = (xs: number[]) => xs.reduce((a, v) => a + v, 0) / (xs.length || 1);
const varOf = (xs: number[]) => { const m = mean(xs); return xs.length > 1 ? xs.reduce((a, v) => a + (v - m) ** 2, 0) / (xs.length - 1) : 0.25; };
/** 回ごとの率の平均の 50% からの z（分散の下限は二項） */
export function zFromHalf(xs: number[]): number {
  if (!xs.length) return 0;
  const sd = Math.sqrt(Math.max(varOf(xs), 0.25 / xs.length));
  return (mean(xs) - 0.5) / (sd / Math.sqrt(xs.length));
}
/** 2群の率の差の z（Welch） */
export function zDiff(a: number[], c: number[]): number {
  if (a.length < 2 || c.length < 2) return 0;
  const se = Math.sqrt(Math.max(varOf(a), 0.25 / a.length) / a.length + Math.max(varOf(c), 0.25 / c.length) / c.length);
  return se ? (mean(a) - mean(c)) / se : 0;
}

/**
 * 回 → 表。groups（型の鍵の一覧・省略時は回に出てくる鍵ぜんぶ）ごとに LEARNABLE_FEATURES を見て、
 *   50% から z≥minZ 上（選んだ方が持つ）・その鍵でない回と minDiff 以上・差の z≥minDiffZ の物だけ。
 *   globalOnly … 型を見ず全回で 50% から z≥minZ 上の物を「全体」に（比べる案）
 */
export function learnPatternBonusTable(eps: ReadonlyArray<PatternEpisode>, cfg: Partial<PatternBonusConfig> = {}, groups?: readonly string[]): PatternBonusTable {
  const c: PatternBonusConfig = { ...PATTERN_BONUS_CONFIG, ...cfg };
  const table: PatternBonusTable = {};
  const ratesOf = (xs: ReadonlyArray<PatternEpisode>, f: PatternFeature) => xs.map((e) => episodeFeatureWin(e, f)).filter((v): v is number => v != null);
  if (c.globalOnly) {
    const rows = LEARNABLE_FEATURES.map((f) => ({ f, r: ratesOf(eps, f) }))
      .filter(({ r }) => r.length >= c.minEpisodes && zFromHalf(r) >= c.minZ)
      .map(({ f, r }) => ({ f, points: c.points, n: r.length, win: +mean(r).toFixed(3) }));
    if (rows.length) table["全体"] = rows;
    return table;
  }
  const keys = groups ?? [...new Set(eps.flatMap((e) => e.keys))].sort();
  for (const k of keys) {
    if (/不明|unknown|none$/.test(k)) continue;
    const xs = eps.filter((e) => e.keys.includes(k)), others = eps.filter((e) => !e.keys.includes(k));
    const rows = LEARNABLE_FEATURES.map((f) => ({ f, r: ratesOf(xs, f), o: ratesOf(others, f) }))
      .filter(({ r, o }) => r.length >= c.minEpisodes && zFromHalf(r) >= c.minZ && mean(r) - mean(o) >= c.minDiff && zDiff(r, o) >= c.minDiffZ)
      .map(({ f, r, o }) => ({ f, points: c.points, n: r.length, win: +mean(r).toFixed(3), others: +mean(o).toFixed(3) }));
    if (rows.length) table[k] = rows;
  }
  return table;
}

/** 表の全部の行（画面・報告用の短い言い方） */
export function describePatternBonusTable(t: PatternBonusTable): string[] {
  return Object.entries(t).flatMap(([k, rows]) => rows.map((r) => `${k} → ${PATTERN_FEATURE_JA[r.f]} +${r.points}（${Math.round(r.win * 100)}%${r.others != null ? `・他 ${Math.round(r.others * 100)}%` : ""}・${r.n}回）`));
}

/**
 * 本番で使う表（2026-10-06 の当て直しの結果）。空＝何も足さない（今の決まりのまま）。
 *   当て直しで「後3割・お客様で分けた両方で新だけ当たり ＞ 旧だけ当たり・下がる型が無い」物だけここに書く（scripts/audit-customer-pattern.ts --part=5）
 */
export const ACTIVE_PATTERN_BONUS_TABLE: Readonly<PatternBonusTable> = {};
