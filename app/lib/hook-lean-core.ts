// app/lib/hook-lean-core.ts（純関数・import なし・画面とサーバーと property-brain で共用）
// 刺さった新着1件から学んだ特徴（hooked-arrival-learning の表）を、判定（property-brain.judgeProperty）で使う最小の部品。
//   property-brain → hooked-arrival-learning → star-rank-pickup → property-brain の輪になるので、判定が要る物だけここに置く（2026-10-06）。
//   hooked-arrival-learning は同じ物をここから受けて外にも出す（今までの import はそのまま使える）。

export type HookFeats = {
  rent_ratio?: number | null;
  area_sqm?: number | null;
  building_age?: number | null;
  walk?: number | null;
  zero_zero?: number | null;
};

/** 特徴の帯（2値）。null＝分からない（数えない） */
export type HookFeatureKey = "rent_upper" | "rent_low" | "zero_zero" | "walk_near" | "age_new" | "age_old" | "area_wide";
export const HOOK_FEATURE_JA: Record<HookFeatureKey, string> = {
  rent_upper: "家賃が上限の9割〜1.1倍", rent_low: "家賃が上限の8割未満", zero_zero: "敷金礼金0", walk_near: "駅徒歩7分以内",
  age_new: "築15年以内", age_old: "築30年以上", area_wide: "広い（一人25㎡以上／二人以上40㎡以上）",
};
export const HOOK_FEATURE_KEYS = Object.keys(HOOK_FEATURE_JA) as HookFeatureKey[];

/** お客様の型（household＝1LDK以上の希望・star-rank-pickup.householdLayoutOf と同じ／initial＝初期費用・敷礼0の希望） */
export type HookCustomerType = { household: boolean; initial: boolean };

/** 型の名前（全体＋一人/二人以上＋初期費用＋組み合わせ）。学ぶ表の鍵 */
export function hookTypeKeys(t: HookCustomerType): string[] {
  const hh = t.household ? "二人以上" : "一人";
  return ["全体", hh, ...(t.initial ? ["初期費用", `${hh}×初期費用`] : [])];
}

export function hookFeatureBits(f: HookFeats, t: HookCustomerType): Record<HookFeatureKey, 0 | 1 | null> {
  const b = (v: boolean | null): 0 | 1 | null => (v == null ? null : v ? 1 : 0);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const r = n(f.rent_ratio), a = n(f.area_sqm), age = n(f.building_age), w = n(f.walk), z = n(f.zero_zero);
  return {
    rent_upper: b(r == null ? null : r >= 0.9 && r <= 1.1),
    rent_low: b(r == null ? null : r < 0.8),
    zero_zero: b(z == null ? null : z === 1),
    walk_near: b(w == null ? null : w <= 7),
    age_new: b(age == null ? null : age <= 15),
    age_old: b(age == null ? null : age >= 30),
    area_wide: b(a == null ? null : a >= (t.household ? 40 : 25)),
  };
}

/** 学んだ表（型 → 特徴の一覧）。保存・受け渡し用の小さな形 */
export type HookLeanTable = Record<string, HookFeatureKey[]>;

/** 1つ当たりの加点と上限（AD の線 15点・状況の足し点 15 より小さく＝主軸を崩さない） */
export const HOOK_BONUS = { bonusEach: 5, bonusMax: 10 } as const;

/**
 * 候補の加点（0 以上だけ）。お客様の型に当たる表の特徴を候補が持っていれば bonusEach ずつ・bonusMax まで。
 *   同じ特徴が「全体」と型の両方にあっても1回だけ数える。分からない特徴は数えない（0）。
 */
export function hookLeanBonus(table: HookLeanTable | null | undefined, type: HookCustomerType, feats: HookFeats, cfg: { bonusEach: number; bonusMax: number } = HOOK_BONUS): { bonus: number; hits: HookFeatureKey[] } {
  if (!table) return { bonus: 0, hits: [] };
  const want = new Set<HookFeatureKey>();
  for (const k of hookTypeKeys(type)) for (const f of table[k] ?? []) want.add(f);
  if (!want.size) return { bonus: 0, hits: [] };
  const bits = hookFeatureBits(feats, type);
  const hits = HOOK_FEATURE_KEYS.filter((f) => want.has(f) && bits[f] === 1);
  return { bonus: Math.min(cfg.bonusMax, hits.length * cfg.bonusEach), hits };
}

// ─── 判定（judgeProperty）に入れる札 ─────────────────────────────────────────
/** 札の名前（HOOK_LEAN_AGE_NEW など）。点は1つ HOOK_BONUS.bonusEach・付けるのは bonusMax まで（property-brain の REASON_POINTS） */
export const HOOK_LEAN_CODE_PREFIX = "HOOK_LEAN_";
export const hookLeanCode = (f: HookFeatureKey) => `${HOOK_LEAN_CODE_PREFIX}${f.toUpperCase()}`;
export const HOOK_LEAN_CODES = HOOK_FEATURE_KEYS.map(hookLeanCode);

/** 判定に渡す材料（呼ぶ側が週の学びの表とお客様の型を渡す・無ければ何も付けない） */
export type HookLeanJudgeInput = { table: HookLeanTable; type: HookCustomerType };

/**
 * 物件の事実 → 付ける札（加点だけ・上限まで・特徴の順）。家賃は (家賃＋管理費)÷上限（scoring-learning-episodes の rent_ratio と同じ）
 */
export function hookLeanCodesOf(
  facts: { rentYen?: number | null; adminFeeYen?: number | null; areaSqm?: number | null; buildingAge?: number | null; walkMinutes?: number | null; depositMonths?: number | null; keyMoneyMonths?: number | null },
  rentMax: number | null | undefined,
  input: HookLeanJudgeInput | null | undefined,
): string[] {
  if (!input || !input.table || !Object.keys(input.table).length) return [];
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const rent = n(facts.rentYen), adm = n(facts.adminFeeYen) ?? 0, d = n(facts.depositMonths), k = n(facts.keyMoneyMonths);
  const feats: HookFeats = {
    rent_ratio: rent != null && rentMax ? (rent + adm) / rentMax : null,
    area_sqm: n(facts.areaSqm), building_age: n(facts.buildingAge), walk: n(facts.walkMinutes),
    zero_zero: d != null && k != null ? (d === 0 && k === 0 ? 1 : 0) : null,
  };
  const { hits } = hookLeanBonus(input.table, input.type, feats);
  return hits.slice(0, Math.floor(HOOK_BONUS.bonusMax / HOOK_BONUS.bonusEach)).map(hookLeanCode);
}
