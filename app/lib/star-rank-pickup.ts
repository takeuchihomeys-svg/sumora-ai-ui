// app/lib/star-rank-pickup.ts（純関数・画面とサーバーで共用・DB/LLM なし）
// 売上サポの行（property_pickups）→ 🌟の並べ方（recommend-star-rank.ts）の候補。
//
// 2026-10-06 竹内さんの決定（A: 今切り替える・いつでも戻せる・2〜3週間後にスタッフの🌟と合っているか確かめる）:
//   👑（一番オススメ＝AIX 物件オススメで送る1件）を「合い方が主軸・AD は 1.5ヶ月の線・刺さる物が無ければ低い AD でも合う物」で決める。
//   値は行に既にある物だけを使う（新しい読み取りはしない）:
//     札と点 … reason_codes と合計（判定の点＋画像の加点・pickup-best.overallPoints）。AD の家族の札の点は合い方から外す
//     広さ   … 説明文の㎡（pickup-dedupe.parseAreaSqm）→ 無ければ資料の表の根拠（terms.evidence.area）
//     築年   … 資料の表（terms.buildingAge）
//     構造   … 資料の設備欄（equipment.facts.structure.d ＝ 木造／軽量鉄骨／鉄骨／RC／SRC）
//     設備   … 資料の設備欄で ○ の数（構造・種別・階などの印は数えない）・希望の設備に合う数（equipment.match の ok）
//     AD     … 判定の AD の札（アズ・スタットの 200%とみなすも含む＝判定と同じ）→ 無ければ ad_yen ÷ 家賃
import { reasonPoints } from "./property-brain";
import { parseAreaSqm } from "./pickup-dedupe";
import { parseRentFromSummary } from "./property-summary-parse";
import type { StarCandidate } from "./recommend-star-rank";

export type StarPickupRow = {
  id: number;
  property_name?: string | null;
  room_no?: string | null;
  reason_codes?: ReadonlyArray<string> | null;
  summary_text?: string | null;
  ad_yen?: number | null;
  equipment?: { facts?: Record<string, { s?: string | null; d?: string | null } | null> | null; match?: ReadonlyArray<{ result?: string | null; mode?: string | null }> | null } | null;
  terms?: { buildingAge?: number | null; evidence?: { area?: string | null } | null } | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** AD の札 → 月数（_HELD は同じ月数）。複数あれば一番大きい月数。札が無ければ null */
const AD_CODE_MONTHS: ReadonlyArray<[RegExp, number]> = [
  [/^AD_VERY_HIGH/, 3], [/^AD_2_5M/, 2.5], [/^AD_HIGH/, 2], [/^AD_ASSUMED_AGENT$/, 2], [/^AD_1_5M/, 1.5], [/^AD_1M/, 1],
  [/^AD_UNDER_1M/, 0.5], [/^AD_NONE/, 0],
];
export function adMonthsOfPickup(r: Pick<StarPickupRow, "reason_codes" | "ad_yen" | "summary_text">): number | null {
  let best: number | null = null;
  for (const c of r.reason_codes ?? []) {
    for (const [re, m] of AD_CODE_MONTHS) if (re.test(c)) { best = best == null ? m : Math.max(best, m); break; }
  }
  if (best != null) return best;
  const rent = parseRentFromSummary(r.summary_text ?? null);
  const ad = num(r.ad_yen);
  return ad != null && rent ? Math.round((ad / rent) * 100) / 100 : null;
}

/** 設備の数に入れない印（構造・種別・階・木造でない・ペット・二人入居・保証人不要は設備ではない） */
const EQUIP_META = new Set(["structure", "bldg_type", "not_wood", "rc", "floor2", "top_floor", "pet", "two_person", "no_guarantor"]);
export function equipmentCountOf(eq: StarPickupRow["equipment"]): number | null {
  const f = eq?.facts;
  if (!f || typeof f !== "object") return null;
  return Object.entries(f).filter(([k, v]) => !EQUIP_META.has(k) && v?.s === "ok").length;
}
export function structureOf(eq: StarPickupRow["equipment"]): string | null {
  const d = eq?.facts?.structure?.d;
  return d && /^(木造|軽量鉄骨|鉄骨|RC|SRC)$/.test(d) ? d : null;
}
export function equipWantHitsOf(eq: StarPickupRow["equipment"]): number | null {
  const m = eq?.match;
  if (!Array.isArray(m) || !m.length) return null;
  return m.filter((x) => x?.result === "ok" && x?.mode !== "ng").length;
}
export function areaSqmOfPickup(r: Pick<StarPickupRow, "summary_text" | "terms">): number | null {
  const a = parseAreaSqm(r.summary_text ?? null);
  if (a != null) return a;
  const ev = String(r.terms?.evidence?.area ?? "").replace(/[０-９．]/g, (c) => (c === "．" ? "." : String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
  const m = ev.match(/(\d+(?:\.\d+)?)\s*(?:㎡|m2|m²|平米)/i);
  const v = m ? parseFloat(m[1]) : NaN;
  return Number.isFinite(v) && v >= 5 && v <= 300 ? v : null;
}

/** 行 → 🌟の候補。score は呼ぶ側の点（合計＝判定の点＋画像の加点）。key は行の id */
export function starCandidateOfPickup(r: StarPickupRow, score: number): StarCandidate {
  return {
    key: String(r.id),
    codes: (r.reason_codes ?? []).slice(),
    score,
    pointsOf: reasonPoints,
    areaSqm: areaSqmOfPickup(r),
    buildingAge: num(r.terms?.buildingAge),
    structure: structureOf(r.equipment),
    equipmentCount: equipmentCountOf(r.equipment),
    equipWantHits: equipWantHitsOf(r.equipment),
    adMonths: adMonthsOfPickup(r),
  };
}
