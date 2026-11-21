/**
 * 画像の種類ごとに、読む欄がどれだけ埋まったか（純関数・LLM なし・2026-11-21 作業員G・台帳 #505 の子・#430）
 *
 * なぜ: 画像の把握の表（memory/image_understanding_map.md の H 節）で、どの種類にも「毎日の数（物差し）」が無かった。
 *   読み・届きを直しても、埋まりが上がったか・崩れたかを毎日見られない。quality_daily に種類×欄の埋まりの割合を書く。
 *
 * 物差しの名前（quality_daily.metric・scope='all'）:
 *   image_fill:customer:<kind>:<欄>   … お客様が送った画像（customer_image_records）。物件の種類だけ（書類・人は数えない）
 *   image_fill:sent:<channel>:<欄>    … こちらが送った画像（sent_image_properties）。channel は送った経路（pickup・recommendation・check・staff_image 等）
 *   value＝埋まった割合（0〜1）・n＝その日の枚数。枚数が5枚未満の種類は書かない（割合が揺れるだけ）
 */

export const CUSTOMER_FILL_KINDS = ["property_material", "property_screen", "property_ad", "property_photo"] as const;
export const CUSTOMER_FILL_FIELDS = ["property_name", "room_no", "rent_yen", "madori", "area_sqm", "station", "walk_min", "age_years"] as const;
/** sent_image_properties の行の欄と facts の鍵 */
export const SENT_FILL_FIELDS: Record<string, (r: SentRow) => unknown> = {
  property_name: (r) => r.property_name,
  room_no: (r) => r.room_no,
  rent: (r) => r.facts?.rent,
  floor_plan: (r) => r.facts?.floor_plan,
  area_sqm: (r) => r.facts?.area_sqm,
  station: (r) => r.facts?.station,
  walk_minutes: (r) => r.facts?.walk_minutes,
  building_age: (r) => r.facts?.building_age,
  status: (r) => r.facts?.status,
};
export const FILL_MIN_N = 5;

export type CustomerRow = { kind: string } & Partial<Record<(typeof CUSTOMER_FILL_FIELDS)[number], unknown>>;
export type SentRow = { channel: string | null; source: string | null; property_name: string | null; room_no: string | null; facts: Record<string, unknown> | null };
export type FillMetric = { metric: string; value: number; n: number };

const filled = (v: unknown) => v !== null && v !== undefined && v !== "";
const rate = (num: number, den: number) => Math.round((num / den) * 1000) / 1000;

export function customerFillMetrics(rows: ReadonlyArray<CustomerRow>): FillMetric[] {
  const out: FillMetric[] = [];
  for (const kind of CUSTOMER_FILL_KINDS) {
    const rs = rows.filter((r) => r.kind === kind);
    if (rs.length < FILL_MIN_N) continue;
    for (const f of CUSTOMER_FILL_FIELDS) out.push({ metric: `image_fill:customer:${kind}:${f}`, value: rate(rs.filter((r) => filled(r[f])).length, rs.length), n: rs.length });
  }
  return out;
}

export function sentChannelOf(r: SentRow): string {
  return r.channel ?? (r.source === "vision" ? "vision" : r.source ?? "unknown");
}

export function sentFillMetrics(rows: ReadonlyArray<SentRow>): FillMetric[] {
  const out: FillMetric[] = [];
  const by = new Map<string, SentRow[]>();
  for (const r of rows) { const c = sentChannelOf(r); const a = by.get(c) ?? []; a.push(r); by.set(c, a); }
  for (const [ch, rs] of [...by].sort(([a], [b]) => a.localeCompare(b))) {
    if (rs.length < FILL_MIN_N) continue;
    for (const [f, get] of Object.entries(SENT_FILL_FIELDS)) out.push({ metric: `image_fill:sent:${ch}:${f}`, value: rate(rs.filter((r) => filled(get(r))).length, rs.length), n: rs.length });
  }
  return out;
}

/**
 * 2026-11-22 作業員G（台帳 #587）: カウンターキッチンの文字の札（property_pickups.equipment.facts.counter_kitchen）と
 *   画像の読み（image_facts.counter_kitchen）の食い違いを数える。食い違った行は目の監査（scripts/image-audit.ts --topic=counter_kitchen_v2）に回す。
 *   image_mismatch:counter_kitchen:<型>  型 = text_ok_image_ng（文字は有る・画像は無い）／text_ng_image_ok／image_only_ok（文字に無く画像だけ有る＝図だけで読んだ例）／
 *   image_only_ng／agree（両方同じ）。n＝画像で読んだ行の数
 */
export type CounterKitchenRow = { id: number; text: string | null; image: boolean | null };
export function counterKitchenAgreement(rows: ReadonlyArray<CounterKitchenRow>): { metrics: FillMetric[]; mismatchIds: number[]; imageOnlyIds: number[] } {
  const read = rows.filter((r) => r.image === true || r.image === false);
  const count: Record<string, number> = { agree: 0, text_ok_image_ng: 0, text_ng_image_ok: 0, image_only_ok: 0, image_only_ng: 0 };
  const mismatchIds: number[] = [], imageOnlyIds: number[] = [];
  for (const r of read) {
    const t = r.text === "ok" ? true : r.text === "ng" ? false : null;
    if (t === null) { count[r.image ? "image_only_ok" : "image_only_ng"]++; if (r.image) imageOnlyIds.push(r.id); }
    else if (t === r.image) count.agree++;
    else { count[t ? "text_ok_image_ng" : "text_ng_image_ok"]++; mismatchIds.push(r.id); }
  }
  const metrics = read.length ? Object.entries(count).map(([k, v]) => ({ metric: `image_mismatch:counter_kitchen:${k}`, value: v, n: read.length })) : [];
  return { metrics, mismatchIds, imageOnlyIds };
}
