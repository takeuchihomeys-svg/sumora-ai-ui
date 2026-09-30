// app/lib/search-override-judge.ts（純関数・DB も fetch も無し）
// メモの上書き（その回だけの一時調整・search-override.ts の SearchOverride）を、判定の材料（お客様の条件欄→プロフィール）に重ねる。
//
// 竹内さんの決定（2026-09-27）「案Aでおこなう」: 上書きで検索した回は判定もその上書きで行う
//   （例 登録が 1K のお客様を 1LDK で検索した回は、1LDK を「合っている」扱い）。
// 決まり（要約の決まり・拡張の applyToCustomer と同じ）:
//   - 上書きした項目だけ。書いていない項目は登録のまま（null の欄は触らない）
//   - 場所: only＝希望エリアをこの場所だけに置き換え／add＝登録の希望エリアに足す（駅は「〇〇駅」で書く＝同じ名前の市・町と取り違えない）
//   - 間取り: 本命をこの間取りだけにし、登録の「も可」（floorPlanAlt）とフォームの希望の行（formWantPlans）は使わない
//       （1LDK で検索した回に登録の 1K を「も可」で合わせると、上書きの意味が消える）
//   - 家賃: 上限を上書きして登録の下限が上限以上になる時は下限を使わない（拡張の readAdjRentMin と同じ＝入力誤りの扱いにしない）
//   - 面積: 下限は sqmMin（判定は上限を見ない＝検索が絞る）
//   - 徒歩・築年: 列を上書き（自由文の「新築」「築浅」の目安は、築年の列があれば使わない＝今の buildCustomerProfile の決まり）
//   - ペット: 相談可を希望に
//   - 階（2026-09-30）: 1＝自由文の欄の階の希望（2階以上・1階NG・3階以上）の節を外す／N＝外して「N階以上」を足す（search-override.ts stripFloorWants）
//   - サイト・広げて/ピンポイント は判定を変えない（判定はいつも広げた検索の幅を見ている）
// 判定・👑・画像で分析の対象・カードの「書いた条件」は全部このプロフィール（と重ねた条件欄）から作るので、同じ値を見る（四者同名）。
import { buildCustomerProfile, normalizeFloorPlanWant, type CustomerLike, type CustomerProfile, type SentRowLike, type PatternRowLike } from "./property-brain";
import { isEmptyOverride, normFloorMin, stripFloorWants, type SearchOverride } from "./search-override";

/** 条件欄のうち上書きで変わる列（property-pickups-server の loadProfile が引く列と同じ名前） */
export type OverridableCustomer = CustomerLike & {
  desired_area?: string | null;
  floor_area_max?: number | null;
};

const splitArea = (s: string | null | undefined): string[] => String(s ?? "").split(/[・、,，/／\n]+/).map((t) => t.trim()).filter(Boolean);
const uniq = (a: string[]): string[] => [...new Set(a.filter(Boolean))];

/** 条件欄の写しに上書きを重ねる（元は変えない）。上書きが無ければ元のまま返す */
export function overlayCustomerForOverride<C extends OverridableCustomer>(c: C, ov: SearchOverride | null | undefined): C {
  if (!ov || isEmptyOverride(ov)) return c;
  const out: C = { ...c };
  const loc = ov.location;
  if (loc) {
    // 駅は「〇〇駅」（「茨木」「大正」を市・区と読まない）・路線・区はそのまま
    const tokens = [...loc.stations.map((s) => (/駅$/.test(s) ? s : `${s}駅`)), ...loc.lines, ...loc.areas];
    if (tokens.length) out.desired_area = uniq(loc.mode === "add" ? [...splitArea(c.desired_area), ...tokens] : tokens).join("・");
  }
  if (ov.floor_plan) { out.floor_plan = ov.floor_plan; out.layout = ov.floor_plan; }
  if (ov.rent_max != null) {
    out.rent_max = ov.rent_max; out.max_rent = ov.rent_max;
    const regMin = Number(c.rent_min);
    if (ov.rent_min == null && Number.isFinite(regMin) && regMin >= ov.rent_max) out.rent_min = null;
  }
  if (ov.rent_min != null) out.rent_min = ov.rent_min;
  if (ov.walk_minutes != null) out.walk_minutes = ov.walk_minutes;
  if (ov.building_age != null) out.building_age = ov.building_age;
  if (ov.area_min != null) out.floor_area_min = ov.area_min;
  if (ov.area_max != null) out.floor_area_max = ov.area_max;
  if (ov.pet) out.pet = true;
  // 階（2026-09-30 竹内「一時的に1階も含む場合は、検索して1階の物件も含めて送ったら大丈夫、その際だけ」）:
  //   登録の階の希望は自由文の欄（こだわり・NG・その他・フォームの原文）にしか無い → その回の写しから階の希望の節を外す（1＝1階も含める）。
  //   N階以上（N≥2）はその節を外したうえで「N階以上」をこだわりの欄に足す。登録の条件（DB）は変えない（写しだけ）
  const fm = normFloorMin(ov.floor_min);
  if (fm != null) {
    const w = out as C & Record<string, unknown>;
    for (const f of FLOOR_TEXT_FIELDS) {
      const v = w[f];
      if (typeof v !== "string" || !v) continue;
      const r = stripFloorWants(v, f);
      if (r.removed.length) (w as Record<string, unknown>)[f] = r.text;
    }
    if (fm >= 2) {
      const pref = typeof w.preferences === "string" && w.preferences.trim() ? `${w.preferences}、` : "";
      (w as Record<string, unknown>).preferences = `${pref}${fm}階以上`;
    }
  }
  return out;
}

/** 階の希望を読む自由文の欄（property-brain・listing-equipment・customer-wants・image-wants が読む欄＝全部） */
const FLOOR_TEXT_FIELDS = ["preferences", "ng_points", "other_requests", "additional_conditions", "raw_format_text", "notes"] as const;

/**
 * 判定の材料（重ねた条件欄とプロフィール）を作る。上書きが無ければ buildCustomerProfile と同じ。
 * property-pickups-server（届いた時の判定）が使う＝判定の点・verdict が上書きで決まり、それを読む 👑・画像で分析の対象・カードも同じ値になる
 */
export function buildProfileWithOverride<C extends OverridableCustomer>(
  customer: C,
  sentRows: SentRowLike[],
  patternRows: PatternRowLike[],
  discountYen: number | null,
  ov: SearchOverride | null | undefined,
  opts: { today?: Date | string } = {},
): { customer: C; profile: CustomerProfile; overridden: boolean } {
  if (!ov || isEmptyOverride(ov)) return { customer, profile: buildCustomerProfile(customer, sentRows, patternRows, discountYen, opts), overridden: false };
  const c2 = overlayCustomerForOverride(customer, ov);
  const profile = buildCustomerProfile(c2, sentRows, patternRows, discountYen, opts);
  if (ov.floor_plan) {
    // 本命はこの間取りだけ（フォームの希望の行・「も可」を足さない）。広さの下限は登録のまま（面積を上書きした時はそれ）
    const reg = buildCustomerProfile(customer, [], [], null, opts);
    profile.floorPlanWant = normalizeFloorPlanWant(ov.floor_plan);
    profile.floorPlanAlt = null;
    profile.sqmMin = ov.area_min ?? reg.sqmMin ?? null;
  }
  return { customer: c2, profile, overridden: true };
}
