// app/lib/customer-condition-view.ts（純関数・DB も fetch も無し・画面から import してよい）
// お客様の物件探しの条件（property_customers の列）を「札の1行ずつ」と「畳んだ時の2〜3行」に直す。
//
// 2026-09-30 竹内（売上サポの朱莉さんの画面のスクショ）「ここにも分かりやすいようにお客さんの条件を入れておく。そうすればスタッフが見れるのと、
//   AIXツールの画面を監視するようになった際も分かりやすいので、ここにお客さんの物件探している条件を入れておく」
//   → 売上サポ（PickupReview）の会話の一番上に常に出す。AIXツールのお客様の一覧（conditions/page.tsx の condItems）も同じ関数で作る（二重に作らない）。
//
// 決まり:
//   - 家賃は管理費・共益費込みで判定・検索している（拡張の totalRentCheck は常にチェック・property-brain の家賃の帯も管理費込み）→ 値に「管理費込み」と書く
//   - 目安の額（「共益費込み、できれば60000円程度」）は property-brain.readRentTarget を正にする（採点と同じ読み取り）
//   - 細かい要望（設備・NG・その他）は customer-wants.itemizeWants の札で出す（ここでは数だけ）
//   - 今回だけの一時調整（property_pickups.search_override）は search-override.overrideShortLabel の文をそのまま使う
import { readRentTarget, type CustomerLike } from "./property-brain";
import { readPickupSearchOverride, overrideShortLabel } from "./search-override";

export type ConditionCustomerLike = CustomerLike & {
  desired_area?: string | null;
  /** 古い列（desired_area が空の人の予備） */
  area?: string | null;
  commute_station?: string | null;
  commute_minutes?: number | null;
  floor_area_max?: number | null;
  exclusion_areas?: string | null;
  structure_types?: string | null;
};

/** 条件の1行（key は data-cond-key に使う安定した名前） */
export type ConditionRow = { key: string; label: string; value: string };

/** 円 → 「7.5万」（小数1桁・0 や空は null） */
export function manYen(yen: number | null | undefined): string | null {
  const n = Number(yen);
  if (yen == null || !Number.isFinite(n) || n <= 0) return null;
  return `${Math.round(n / 1000) / 10}万`;
}

const SHIKIREI_RE = /敷礼なし|敷金礼金なし|敷金礼金0|敷金0礼金0|敷0礼0/;

/** 家賃の値（「6万〜8万円（管理費込み）・目安 6万（共益費込み）」）。上限も下限も無ければ null */
export function rentValue(c: ConditionCustomerLike): string | null {
  const max = c.rent_max ?? c.max_rent ?? null;
  const min = c.rent_min ?? null;
  const hi = manYen(max);
  // 下限が上限以上なら下限は使われない（拡張の readAdjRentMin・search-override.overrideLine と同じ）
  const lo = min && (!max || Number(min) < Number(max)) ? manYen(min) : null;
  if (!hi && !lo) return null;
  let v = hi && lo ? `${lo}〜${hi}円` : hi ? `〜${hi}円` : `${lo}円〜`;
  v += "（管理費込み）";
  const target = readRentTarget(c, min ?? null, max ?? null);
  if (target) v += `・目安 ${manYen(target.yen)}${target.withAdmin ? "（共益費込み）" : "（家賃だけ）"}`;
  return v;
}

/**
 * お客様の条件の行（並び＝AIXツールのお客様の一覧と同じ: 入居時期・エリア・家賃・徒歩・間取り・広さ・築年数・初期費用・ペット・通勤先・敷礼
 *   ＋ 除外エリア・構造）。値の無い項目は出さない
 */
export function customerConditionItems(c: ConditionCustomerLike | null | undefined): ConditionRow[] {
  if (!c) return [];
  const out: ConditionRow[] = [];
  const push = (key: string, label: string, value: string | null | undefined) => {
    const v = String(value ?? "").trim();
    if (v) out.push({ key, label, value: v });
  };
  push("move_in", "入居時期", c.move_in_time);
  push("area", "エリア", c.desired_area || c.area);
  push("rent", "家賃", rentValue(c));
  if (c.walk_minutes) push("walk", "徒歩", `${c.walk_minutes}分以内`);
  push("floor_plan", "間取り", c.floor_plan || c.layout);
  if (c.floor_area_min || c.floor_area_max) {
    push("floor_area", "広さ", `${c.floor_area_min ? `${c.floor_area_min}㎡以上` : ""}${c.floor_area_max ? `〜${c.floor_area_max}㎡` : ""}`);
  }
  if (c.building_age) push("building_age", "築年数", `${c.building_age}年以内`);
  if (c.initial_cost_limit) push("initial_cost", "初期費用", `${manYen(c.initial_cost_limit)}円以内`);
  if (c.pet != null) push("pet", "ペット", c.pet ? "飼育あり" : "なし");
  if (c.commute_station) push("commute", "通勤先", `${c.commute_station}${c.commute_minutes ? `(${c.commute_minutes}分)` : ""}`);
  if (SHIKIREI_RE.test(`${c.preferences ?? ""} ${c.ng_points ?? ""} ${c.other_requests ?? ""}`)) push("shikirei", "敷礼", "敷礼なし");
  push("exclusion", "除外エリア", c.exclusion_areas);
  push("structure", "構造", c.structure_types);
  return out;
}

/**
 * 畳んだ時の2〜3行（スマホで要点だけ）。
 *   1行目: エリア・通勤／2行目: 家賃・間取り・広さ・徒歩・築年数／3行目: 入居時期・初期費用・ペット・敷礼（無ければ出さない）
 */
export function conditionHeadlineLines(rows: ReadonlyArray<ConditionRow>): string[] {
  const v = (k: string) => rows.find((r) => r.key === k)?.value ?? null;
  const join = (xs: Array<string | null>) => xs.filter(Boolean).join("・");
  const l1 = join([v("area") ? `📍${v("area")}` : null, v("commute") ? `通勤 ${v("commute")}` : null]);
  const l2 = join([v("rent") ? `💴${v("rent")}` : null, v("floor_plan"), v("floor_area"), v("walk") ? `徒歩${v("walk")}` : null, v("building_age") ? `築${v("building_age")}` : null]);
  const l3 = join([v("move_in") ? `入居 ${v("move_in")}` : null, v("initial_cost") ? `初期費用 ${v("initial_cost")}` : null,
    v("pet") ? `ペット ${v("pet")}` : null, v("shikirei")]);
  return [l1, l2, l3].filter(Boolean);
}

/**
 * 今回だけの一時調整（一番新しい回の行の search_override）。無ければ null。
 *   rows は一番新しい回の物件の行（search_override の列だけ読む）。行ごとに違う時は最初に読めた物
 */
export function latestOverrideLabel(rows: ReadonlyArray<{ search_override?: unknown }> | null | undefined): string | null {
  for (const r of rows ?? []) {
    const p = readPickupSearchOverride(r.search_override);
    const label = p ? overrideShortLabel(p.override) : "";
    if (label) return label;
  }
  return null;
}
