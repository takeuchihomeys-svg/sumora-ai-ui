// app/lib/scoring-learning-episodes.ts
// 物件の点の学習（scoring-learning.ts）に渡す「スタッフが選んだ1回」を、記録から組み立てる純関数（DB・ネットに触れない）。
//
// 2026-09-25 竹内「自動的に学習されていく仕組みを作る」。正解は「スタッフが選んで送った事実」（feedback_property_selection_label）。
//
// ■ 3つの材料（どれも「どの候補にも同じ道で届く値」だけを使う＝選んだ物だけが材料を多く持つと順位が歪む）
//   snapshot: recommendation_snapshots（🌟を送った時点の候補＝同じ会話で直近72時間にお客様に送った物件）。選んだ物＝is_star。
//             🌟の本文の値（star_text_facts）は使わない（🌟だけが持つ材料）。
//   pickup:   property_pickups の1回（batch_id）。選んだ物＝status 'sent'（スタッフが送った）。札は保存済みの reason_codes。
//             DeepSeek の🌟（recommended）は正解に使わない（スタッフの選択ではない）。
//   pool:     property_candidate_pools（拡張の回）。選んだ物＝その回の後 72時間以内にお客様に届いた送付（sent_properties の customer）。
//             候補の値はプールの値だけ（送付記録の家賃は選んだ物にしか無いので使わない）。
// ■ お客様の条件は property_condition_history でその時点へ戻す（その時点より後の変更は old_value）。

import {
  buildCustomerProfile, judgeProperty, parsePropertyFacts, matchFloorPlan, normalizeBuildingName, baseReasonPoints,
  type CustomerLike, type SentRowLike, type PatternRowLike, type PropertyFacts, type CustomerProfile,
} from "./property-brain";
import { parseAreaWant, parseCommuteWants, buildPropertyLocation, matchArea, matchCommute, locationReasonCodes } from "./area-want";
import type { Episode, EpisodeCandidate } from "./scoring-learning";

type Row = Record<string, any>;
const H = 3600_000;

// ─── 名前 ────────────────────────────────────────────────────────────────────

const half = (s: string) => String(s ?? "").normalize("NFKC");
function splitRoom(name: string): { building: string; room: string } {
  const s = half(name).trim();
  const m = s.match(/[\s　]*(\d{1,4})\s*号室?\s*$/) ?? s.match(/[\s　]+(\d{1,4})$/);
  if (!m) return { building: s, room: "" };
  return { building: s.slice(0, m.index ?? 0).trim(), room: m[1].replace(/^0+(?=\d)/, "") };
}
const bkey = (name: string) => normalizeBuildingName(splitRoom(name).building).replace(/[・･\-‐ー－\s]/g, "").toLowerCase();
/** 同じ建物か（完全一致・5文字以上の包含・6文字以上で2文字組の一致度 0.75 以上。監査 audit-star-by-conditions と同じ線） */
export function sameBuilding(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = bkey(String(a ?? "")), y = bkey(String(b ?? ""));
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x))) return true;
  if (Math.min(x.length, y.length) < 6) return false;
  const bg = (s: string) => { const o = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); o.set(k, (o.get(k) ?? 0) + 1); } return o; };
  const A = bg(x), B = bg(y); let inter = 0;
  for (const [k, n] of A) inter += Math.min(n, B.get(k) ?? 0);
  return (2 * inter) / (x.length - 1 + y.length - 1) >= 0.75;
}
const normRoom = (r: unknown) => half(String(r ?? "")).replace(/号室?$/, "").replace(/^0+(?=\d)/, "").trim();

// ─── 条件をその時点へ戻す ────────────────────────────────────────────────────

const NUM_FIELDS = new Set(["rent_max", "rent_min", "walk_minutes", "building_age", "initial_cost_limit", "max_rent", "floor_area_min", "commute_minutes"]);
export type ConditionHistoryRow = { changed_field: string; old_value: unknown; created_at: string };

/** その時刻より後の変更を old_value に戻した条件（列に無い項目は戻さない） */
export function customerAt<T extends Row>(cust: T, history: ConditionHistoryRow[], atIso: string): { c: T; restored: string[] } {
  const t = Date.parse(atIso);
  const base: Row = { ...cust };
  const later = history.filter((h) => Date.parse(h.created_at) > t).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const done = new Set<string>(), restored: string[] = [];
  for (const h of later) {
    if (done.has(h.changed_field) || !(h.changed_field in base)) continue;
    done.add(h.changed_field);
    const v = h.old_value;
    base[h.changed_field] = NUM_FIELDS.has(h.changed_field) ? (v == null || v === "" ? null : parseInt(String(v).replace(/[^\d]/g, ""), 10) || null) : v;
    restored.push(h.changed_field);
  }
  return { c: base as T, restored };
}

// ─── 条件の種類 ──────────────────────────────────────────────────────────────

export const SEGMENT_JA: Record<string, string> = {
  low_initial: "初期費用を抑えたい人", walk_want: "徒歩の希望がある人", age_want: "築年の希望がある人", plan_want: "間取りの希望がある人",
  area_want: "エリアの希望がある人", pet: "ペットを飼う人", sqm_want: "広さの希望がある人", equip_want: "設備の希望がある人",
};

function customerText(c: Row): string {
  return [c.preferences, c.ng_points, c.other_requests, c.additional_conditions, c.raw_format_text].filter(Boolean).map(String).join("\n");
}

/** 設備の語（候補の equipment のラベル）で、お客様の条件の文に出てくる物（希望の設備） */
const EQUIP_WANT_WORDS: Array<[string, RegExp]> = [
  ["オートロック", /オートロック/], ["宅配ボックス", /宅配(?:ボックス|BOX|box)/i], ["バス・トイレ別", /バス(?:・)?トイレ別|風呂(?:と)?トイレ(?:が)?別|BT別/],
  ["独立洗面台", /独立洗面|洗面台/], ["室内洗濯機置場", /室内洗濯機/], ["エレベーター", /エレベーター/], ["追い焚き", /追(?:い)?焚|追炊/],
  ["浴室乾燥機", /浴室(?:換気)?乾燥/], ["2口コンロ", /(?:2|二)口/], ["ネット無料", /ネット(?:無料)?|Wi-?Fi/i], ["角部屋", /角部屋/], ["南向き", /南向き/],
  ["ペット相談", /ペット/], ["駐車場", /駐車場/], ["ウォークインクローゼット", /ウォークイン|WIC/i], ["温水洗浄便座", /温水洗浄|ウォシュレット/],
];
export function equipmentWantLabels(cust: Row): string[] {
  const t = half(customerText(cust));
  return EQUIP_WANT_WORDS.filter(([, re]) => re.test(t)).map(([l]) => l);
}

export function segmentsOf(prof: CustomerProfile, cust: Row): string[] {
  const s: string[] = [];
  if (prof.wantsLowInitialCost) s.push("low_initial");
  if (prof.walkMax != null) s.push("walk_want");
  if (prof.buildingAgeMax != null || prof.ageTextMax) s.push("age_want");
  if (!prof.floorPlanWant.any) s.push("plan_want");
  if (String(cust.desired_area ?? "").trim()) s.push("area_want");
  if (prof.pet) s.push("pet");
  if (prof.sqmMin != null) s.push("sqm_want");
  if (equipmentWantLabels(cust).length) s.push("equip_want");
  return s;
}

// ─── 候補 → 札と特徴 ─────────────────────────────────────────────────────────

/** 候補の値（recommendation_snapshots・property_candidate_pools の candidates の1件。鍵は candidate-facts.ts と同じ名前） */
export type CandLike = {
  name?: string | null; room_no?: string | null; rank?: number | null; pool_rank?: number | null;
  rent?: number | null; admin_fee_yen?: number | null; deposit_months?: number | null; key_money_months?: number | null;
  floor_plan?: string | null; area_sqm?: number | null; building_age?: number | null; walk_minutes?: number | null;
  station?: string | null; stations?: Array<{ line: string | null; station: string; walk: number }> | null;
  floor?: number | null; ad_months?: number | null; ad_yen?: number | null; equipment?: string[] | null;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export type JudgeContext = {
  profile: CustomerProfile;
  customer: Row;
  today: string;
};

export function buildContext(cust: Row, sentBefore: SentRowLike[], patterns: PatternRowLike[], today: string): JudgeContext {
  const profile = buildCustomerProfile(cust as CustomerLike, sentBefore, patterns, null, { today });
  return { profile, customer: cust, today };
}

/** 候補1件を judgeProperty に当て、札と特徴を返す */
export function judgeCandidate(c: CandLike, i: number, ctx: JudgeContext): { codes: string[]; feats: Record<string, number | null>; score: number } {
  const name = String(c.name ?? "").trim();
  const room = normRoom(c.room_no);
  const rank = num(c.pool_rank) ?? num(c.rank) ?? i + 1;
  const f: PropertyFacts = parsePropertyFacts(`【${rank}】${name}${room ? ` ${room}号室` : ""}`, {
    rank, name, rent: num(c.rent), floor_plan: c.floor_plan ?? null, walk_minutes: num(c.walk_minutes),
    ad_months: num(c.ad_months), ad_yen: num(c.ad_yen), deposit_months: num(c.deposit_months), key_money_months: num(c.key_money_months),
  });
  f.adminFeeYen = num(c.admin_fee_yen);
  f.buildingAge = num(c.building_age);
  f.areaSqm = num(c.area_sqm);
  f.roomNo = room || null;
  if (num(c.deposit_months) != null) f.depositMonths = num(c.deposit_months);
  if (num(c.key_money_months) != null) f.keyMoneyMonths = num(c.key_money_months);
  // エリア・通勤（候補に駅がある時だけ）
  let locationCodes: string[] = [];
  const cust = ctx.customer;
  const st = (c.stations && c.stations[0]) ? c.stations[0] : c.station ? { line: null, station: c.station, walk: num(c.walk_minutes) ?? 0 } : null;
  if (st?.station) {
    const areaW = parseAreaWant(cust.desired_area, [cust.preferences, cust.other_requests].filter(Boolean).join("\n"));
    const commW = parseCommuteWants(cust);
    if (areaW.any || commW.length) {
      const line = `${st.line ?? ""} ${st.station}駅 徒歩${st.walk}分`;
      const loc = buildPropertyLocation(`【1】${name}\n${line}`, null);
      locationCodes = locationReasonCodes(matchArea(areaW, loc), matchCommute(commW, loc));
    }
  }
  const j = judgeProperty(f, ctx.profile, i, { today: ctx.today, locationCodes });
  // 特徴（値が無ければ null）
  const p = ctx.profile;
  const rentTotal = f.rentYen != null ? f.rentYen + (f.adminFeeYen ?? 0) : null;
  const ratio = rentTotal != null && p.rentMax ? +(rentTotal / p.rentMax).toFixed(3) : null;
  const adM = f.adMonths ?? (f.adYen != null && f.rentYen ? +(f.adYen / f.rentYen).toFixed(2) : null);
  const fm = !p.floorPlanWant.any && f.floorPlan ? matchFloorPlan(p.floorPlanWant, f.floorPlan) : null;
  const wants = equipmentWantLabels(cust);
  const eq = Array.isArray(c.equipment) ? c.equipment : null;
  const feats: Record<string, number | null> = {
    rent_ratio: ratio,
    walk: f.walkMinutes,
    building_age: f.buildingAge,
    area_sqm: f.areaSqm ?? null,
    zero_zero: f.depositMonths != null && f.keyMoneyMonths != null ? (f.depositMonths === 0 && f.keyMoneyMonths === 0 ? 1 : 0) : null,
    plan_match: fm === "match" ? 2 : fm === "near" ? 1 : fm === "mismatch" ? 0 : null,
    ad_months: adM,
    floor: num(c.floor),
    equipment_count: eq ? eq.length : null,
    equip_want_hits: eq && wants.length ? wants.filter((w) => eq.includes(w)).length : null,
    pool_rank: num(c.pool_rank) ?? num(c.rank),
    score: 50 + j.reasonCodes.reduce((a, k) => a + baseReasonPoints(k), 0),
    within_rent: ratio != null ? (ratio <= 1.1 ? 1 : 0) : null,
    within_walk: f.walkMinutes != null && p.walkMax != null ? (f.walkMinutes <= p.walkMax ? 1 : 0) : null,
    within_age: f.buildingAge != null && p.buildingAgeMax != null ? (f.buildingAge <= p.buildingAgeMax ? 1 : 0) : null,
    new_build: f.buildingAge != null ? (f.buildingAge <= 10 ? 1 : 0) : null,
  };
  return { codes: j.reasonCodes, feats, score: j.score };
}

/**
 * AD 2ヶ月の物件に付く AD の札（judgeProperty で作る＝AD の段の決まりが変わっても追いかける）。
 *   家賃 10万円・AD 2ヶ月・条件なしのお客様で判定し、AD の札（AD_・PROFIT_）だけ返す。AD の方針（他の約1.3倍）の上限に使う
 */
export function adTwoMonthCodes(): string[] {
  const prof = buildCustomerProfile({} as CustomerLike, [], [], null, {});
  const f = parsePropertyFacts('【1】テスト物件', { rank: 1, name: 'テスト物件', rent: 100_000, ad_months: 2 });
  const j = judgeProperty(f, prof, 0, {});
  return j.reasonCodes.filter((c) => /^AD_|^PROFIT_/.test(c));
}

// ─── 1回を組み立てる ─────────────────────────────────────────────────────────

/** recommendation_snapshots の1行 → 1回（選んだ物＝is_star）。候補が2件未満・🌟が候補に無い回は null */
export function episodeFromSnapshot(snap: Row, ctx: JudgeContext): Episode | null {
  const raw = (typeof snap.candidates === "string" ? JSON.parse(snap.candidates) : snap.candidates) as Array<CandLike & { is_star?: boolean }> | null;
  if (!Array.isArray(raw) || raw.length < 2 || !snap.star_in_candidates) return null;
  const cands: EpisodeCandidate[] = [];
  const seen = new Set<string>();
  raw.forEach((c, i) => {
    const k = `${bkey(String(c.name ?? ""))}#${normRoom(c.room_no)}`;
    if (!c.name || seen.has(k)) return;
    seen.add(k);
    const r = judgeCandidate(c, i, ctx);
    cands.push({ key: `${c.name}${c.room_no ? ` ${normRoom(c.room_no)}` : ""}`, chosen: !!c.is_star, codes: r.codes, feats: r.feats });
  });
  if (!cands.some((c) => c.chosen) || !cands.some((c) => !c.chosen)) return null;
  return { id: `snap:${snap.id}`, at: new Date(snap.sent_at).toISOString(), source: "snapshot", segments: segmentsOf(ctx.profile, ctx.customer), cands };
}

/** property_pickups の1回（同じ batch_id の行）→ 1回（選んだ物＝status 'sent'）。札は保存済みの reason_codes */
export function episodeFromPickups(rows: Row[], segments: string[]): Episode | null {
  if (rows.length < 2) return null;
  const cands: EpisodeCandidate[] = rows.map((r) => {
    const codes = (Array.isArray(r.reason_codes) ? r.reason_codes : []) as string[];
    return {
      key: `${r.property_name ?? ""}${r.room_no ? ` ${r.room_no}` : ""}`, chosen: r.status === "sent" || !!r.sent_at, codes,
      feats: { score: 50 + codes.reduce((a, k) => a + baseReasonPoints(k), 0), pool_rank: num(r.rank) },
    };
  });
  if (!cands.some((c) => c.chosen) || !cands.some((c) => !c.chosen)) return null;
  const at = rows.map((r) => String(r.sent_at ?? r.created_at)).sort()[0];
  return { id: `pickup:${rows[0].batch_id}`, at: new Date(at).toISOString(), source: "pickup", segments, cands };
}

/** 拡張の回で、その後 72時間以内にお客様に届いた送付（delivery='customer' か、delivery が無く line_group でない） */
export const POOL_SENT_WINDOW_MS = 72 * H;
export function isCustomerSend(s: Row): boolean {
  if (s.delivery === "shared") return false;
  if (s.delivery == null && s.source === "line_group") return false;
  return true;
}

/** property_candidate_pools の1回 → 1回（選んだ物＝その後 72時間以内にお客様に届いた物件）。値はプールの値だけ */
export function episodeFromPool(pool: Row, sentAfter: Row[], ctx: JudgeContext): Episode | null {
  const raw = (typeof pool.candidates === "string" ? JSON.parse(pool.candidates) : pool.candidates) as CandLike[] | null;
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const t = Date.parse(pool.sent_at);
  const sends = sentAfter.filter((s) => isCustomerSend(s) && s.property_name && Date.parse(s.sent_at) >= t - 10 * 60_000 && Date.parse(s.sent_at) <= t + POOL_SENT_WINDOW_MS);
  if (!sends.length) return null;
  const seen = new Set<string>();
  const cands: EpisodeCandidate[] = [];
  raw.forEach((c, i) => {
    const k = `${bkey(String(c.name ?? ""))}#${normRoom(c.room_no)}`;
    if (!c.name || seen.has(k)) return;
    seen.add(k);
    const chosen = sends.some((s) => sameBuilding(s.property_name, c.name) && (!s.room_no || !c.room_no || normRoom(s.room_no) === normRoom(c.room_no)));
    const r = judgeCandidate(c, i, ctx);
    cands.push({ key: `${c.name}${c.room_no ? ` ${normRoom(c.room_no)}` : ""}`, chosen, codes: r.codes, feats: r.feats });
  });
  if (!cands.some((c) => c.chosen) || !cands.some((c) => !c.chosen)) return null;
  return { id: `pool:${pool.id}`, at: new Date(pool.sent_at).toISOString(), source: "pool", segments: segmentsOf(ctx.profile, ctx.customer), cands };
}
