// app/lib/proposal-range.ts — このお客様に「条件から広げて提案してよい範囲」（ブレインの判断を材料に・純関数・DB/fetch/LLM 無し）
//
// 2026-10-13 竹内さん: 「ブレインとぶつかる変な決まり・昔の制限を根本からブレイン基準に。規則は候補の網と安全の線だけ」
//   訂正（同日）「広げて検索の部分ではなくて、お客さんに広げて提案できるところの範囲」
//   設計知見 P0 9eb6aa9c（判断はすべてブレイン基準）・P1 0593a0aa（判断も表示も次の行動もブレインが決めた事を使う・ブレインの入力の経路に答えを戻さない）・
//   P1 3b508208（物差し: 物件選び・資料は竹内さん＋スタッフの送信／文は竹内さんの LINE だけ）・P1 a8f86224（判定の点は広げた幅を帯にする）
//
// ■ 何を決めるか
//   お客様ごとに「どこまでなら広げて提案してよいか」を段（ProposalLevel）と軸ごとの可否で決め、判定（property-brain.judgeProperty）の点・👑・保留に使う。
//   ここで発言を読まない（ブレインとぶつけない）。材料は2種類で、使い道を分ける（2026-10-13 確かめる人の重要2）:
//   ① 残り続ける記録（保留も付けてよい）: property_customers.requirement_strength（エリア・家賃の「必ず」「できれば」）
//   ② 続いている判断・記録（加点だけ・保留は付けない）: ブレインの判断が続いている時（brain_decision_logs の直近14日で同じ状態・決め手の残りが2回以上）・
//      決め手の条件（closing-target・会話の21日から毎回同じ形で作る像）の型と気に入った部屋の駅・requirement_strength の「できれば」
//   ⚠ 使わない物: suggested_aix_meta（最新の1通の判断・次の発言で null に戻る・customer_mindset は今回の発言の層だけ）と condition_change_type（毎通ゼロから）。
//     使うと「安くしたい」の次の「ありがとう」で段が変わり、記録の時と判定の時で保留・👑 が食い違う（190人中 customer_mindset あり16・condition_change_type 全員 null）。
//   ⚠ 決め手の条件の「駅近」（closer）・決め手の残りの「立地・駅」は徒歩の分数の話（closing-target の CLOSER_RE）でエリアではない＝場所の段に使わない（重要1）。
//
// ■ 実送信の当て直し（scripts/audit-proposal-range.ts・120日・竹内さん＋スタッフが送った物件 × その後の🌟・反応・内覧・申込）
//   エリアの帯ごとの刺さり: 希望の駅 23%／2駅 21%／2km 20%／範囲 24%／4km・隣の区 17%／遠い（4km超）16%。
//   ＝点の帯の中（2駅・2km・範囲・隣の区）は希望どおりと同じくらい刺さる。遠い物件も 0 ではない（16%）＝「広げて提案してよいお客様」がいる。
//   ただし「前に広げた物件が刺さったか」で次の刺さりは変わらない（20%／19%）＝反応の数は物差しとして弱い。
//
// ■ 段（ProposalLevel）
//   tight    … エリアが「必ず」（requirement_strength）だけ → 隣の区・4km（AREA_CLOSE）・遠い（AREA_FAR）は保留（PROPOSAL_AREA_OUT −10）・2駅・2km・範囲は −3（PROPOSAL_AREA_EDGE）
//   standard … 材料が無い時の既定（今までの点のまま）
//   broad    … 広げて提案してよい（加点だけ）: ブレインの判断が続いている（急いでいる・安くしたい／決め手の残りが家賃・初期費用・広さ・築年で別の物件で解く）／
//              決め手の条件が家賃を下げる・初期費用・広さ・築年／エリアが「できれば」／気に入った部屋が希望の場所の外 → 遠い物件の −3 を戻す（+3）・隣の区 +2
//   tight と broad の両方の材料がある時は tight（場所をはっきり言っている方を守る＝安全の線）。
// ■ 軸ごと（保留を付ける物は残り続ける記録だけ）
//   家賃: requirement_strength の家賃が「必ず」→ 上限を少しでも超える物件（RENT_WIDE・RENT_SLIGHTLY_OVER）は保留（PROPOSAL_RENT_OUT）
//         （1割超は requirement-strength の RENT_OVER_MUST・拡張の広げても家賃を上げない wide-rent.js と同じ線）
//   築年・広さ: 今は残り続ける記録が無い（決め手の条件の広さ・築浅は一時の意図＝closing-target の temporary）ので広げてよいのまま（ageWide・sizeWide は true）
//
// 戻す: 環境変数 PROPOSAL_RANGE=off（判定は今までの点のまま）
import { matchArea, parseAreaWant, AREA_NEAR_KM, type AreaWant, type PropertyLocation } from "./area-want";
import { STATION_COORDS, STATION_LINES, WARD_COORDS, wardOfStation, distanceKm, stationPoint, wardPoint, normStation, isKnownStation } from "./osaka-geo";

import { PROPOSAL_RANGE_VERSION, type ProposalLevel, type ProposalRange } from "./proposal-range-codes";
export { PROPOSAL_RANGE_VERSION, proposalRangeEnabled, proposalRangeCodes, wideSqmMargin, FEWER_ROOM_LDK_MIN_SQM, PROPOSAL_POINTS, PROPOSAL_JA, PROPOSAL_HOLD_CODES, type ProposalLevel, type ProposalRange } from "./proposal-range-codes";

/** 範囲の材料（どれも無くてよい） */
export type ProposalMaterials = {
  /** ① 残り続ける記録: property_customers.requirement_strength（area・rent_max の強さ） */
  areaStrength?: string | null;
  rentStrength?: string | null;
  /** ② 決め手の条件（closing-target）の型（rent_lower・wider・newer…）。found（もう見つかった）は渡さない。加点だけに使う */
  closingKinds?: ReadonlyArray<string> | null;
  /** ② 気に入った部屋（決め手の条件の favorite）の駅。希望の場所の外なら、お客様はその場所を受け入れている（加点だけ） */
  favoriteStations?: ReadonlyArray<string> | null;
  /**
   * ② ブレインの直近の判断（brain_decision_logs.digest の ms＝customer_mindset の要約「状態|不安|迷い|点:解き方」・新しい順・14日以内）。
   *   同じ状態・決め手の残りが2回以上ある時だけ「続いている判断」として加点に使う（1通だけの判断では段を変えない）
   */
  brainRecent?: ReadonlyArray<{ state?: string | null; gapPoint?: string | null; gapSolve?: string | null }> | null;
};

const BROAD_GAP_POINTS = new Set(["家賃", "初期費用", "広さ", "築年"]);
const BROAD_STATES = new Set(["急いでいる", "安くしたい"]);
const BROAD_CLOSING = new Set(["rent_lower", "initial_cost", "wider", "newer"]);
const CLOSING_JA: Record<string, string> = { rent_lower: "家賃を下げる", initial_cost: "初期費用", wider: "広さ", newer: "築年" };
/** 続いている判断とみなす回数（直近の判断のうち同じ物がこの回数以上） */
export const BRAIN_STREAK_MIN = 2;
/** 見るブレインの判断の数・日数 */
export const BRAIN_RECENT_MAX = 6;
export const BRAIN_RECENT_DAYS = 14;

/** brain_decision_logs.digest.ms（「状態|不安:向き|迷い|点:解き方」）→ 材料の1件 */
export function brainRecentOfDigest(ms: unknown): { state: string | null; gapPoint: string | null; gapSolve: string | null } | null {
  if (typeof ms !== "string" || !ms.trim()) return null;
  const [state, , , gap] = ms.split("|");
  const [gp, gs] = String(gap ?? "").split(":");
  return { state: state?.trim() || null, gapPoint: gp?.trim() || null, gapSolve: gs?.trim() || null };
}

/**
 * 提案してよい範囲（純）。opts.wantStations／wantWards は希望の駅・区（気に入った部屋が希望の場所の外かを見るだけ）
 */
export function decideProposalRange(m: ProposalMaterials, opts: { wantStations?: ReadonlyArray<string>; wantWards?: ReadonlyArray<string> } = {}): ProposalRange {
  const tight: string[] = [];
  const broad: string[] = [];
  const closing = new Set((m.closingKinds ?? []).map(String));
  // ① 保留を付けてよい材料（残り続ける記録）
  if (m.areaStrength === "must") tight.push("エリアは必ず");
  // ② 加点だけの材料
  const recent = (m.brainRecent ?? []).slice(0, BRAIN_RECENT_MAX);
  for (const st of BROAD_STATES) {
    const n = recent.filter((r) => r.state === st).length;
    if (n >= BRAIN_STREAK_MIN) broad.push(`ブレイン: ${st}（直近の判断で${n}回）`);
  }
  for (const pt of BROAD_GAP_POINTS) {
    const n = recent.filter((r) => r.gapPoint === pt && (r.gapSolve === "c" || !r.gapSolve)).length;
    if (n >= BRAIN_STREAK_MIN) broad.push(`ブレイン: 決め手の残りが${pt}（別の物件で解く・${n}回）`);
  }
  for (const k of closing) if (BROAD_CLOSING.has(k)) broad.push(`決め手の条件: ${CLOSING_JA[k] ?? k}`);
  if (m.areaStrength === "nice") broad.push("エリアはできれば");
  const wantSt = new Set(opts.wantStations ?? []);
  const wantWd = new Set(opts.wantWards ?? []);
  const favOut = (m.favoriteStations ?? []).map((s) => normStation(s)).find((s) => s && isKnownStation(s) && !wantSt.has(s) && !(wardOfStation(s) && wantWd.has(wardOfStation(s) as string)));
  if (favOut && (wantSt.size || wantWd.size)) broad.push(`気に入った部屋の駅（${favOut}）が希望の場所の外`);

  const level: ProposalLevel = tight.length ? "tight" : broad.length ? "broad" : "standard";
  const rentTight = m.rentStrength === "must";
  const reasons = tight.length ? [...tight, ...(broad.length ? [`（広げる材料もあるが場所を守る: ${broad.join("・")}）`] : [])] : broad.length ? broad : [];
  if (rentTight) reasons.push("家賃の上限は超えない（家賃は必ず）");
  return { v: 1, version: PROPOSAL_RANGE_VERSION, level, rentOver: !rentTight, ageWide: true, sizeWide: true, reasons };
}

/** 材料が無い時の範囲（今までの点のまま＋既定の広さ・間取りの帯） */
export const DEFAULT_PROPOSAL_RANGE: ProposalRange = { v: 1, version: PROPOSAL_RANGE_VERSION, level: "standard", rentOver: true, ageWide: true, sizeWide: true, reasons: [] };

// ─── 案: 検索の網（本番のどこからも呼ばない・つながっていない＝scripts/audit-widen-scope.ts の当て直しだけが使う・報告の案） ───

/**
 * 案（未接続）: 提案してよい範囲を検索が取りこぼしている時に、拡張の広げての回に足す駅・区（点の帯の駅を matchArea で選ぶ）。
 *   scripts/audit-widen-scope.ts の当て直し: 点は付くのに今の網（前後1駅）の外 355部屋のうち standard で 115・broad で 180 を取れる・点の付かない物件（FAR）は 0。
 *   拡張の変更（popup・background・resolution-core）と配布が要るので、竹内さんの判断を待つ
 */
export const NET_LEVEL_CODES: Record<ProposalLevel, ReadonlyArray<string>> = {
  tight: [], standard: ["AREA_STATION_2STOPS", "AREA_NEAR"], broad: ["AREA_STATION_2STOPS", "AREA_NEAR", "AREA_REGION_MATCH", "AREA_CLOSE"],
};
export const NET_LEVEL_WARD_CODES: Record<ProposalLevel, ReadonlyArray<string>> = {
  tight: [], standard: ["AREA_NEAR", "AREA_CLOSE"], broad: ["AREA_NEAR", "AREA_REGION_MATCH", "AREA_CLOSE"],
};
const NET_PER_PLACE: Record<ProposalLevel, number> = { tight: 0, standard: 8, broad: 12 };
const NET_MAX_STATIONS: Record<ProposalLevel, number> = { tight: 0, standard: 30, broad: 40 };
const NET_MAX_WARDS: Record<ProposalLevel, number> = { tight: 0, standard: 4, broad: 8 };
const RANK: Record<string, number> = { AREA_STATION_2STOPS: 0, AREA_NEAR: 1, AREA_REGION_MATCH: 2, AREA_CLOSE: 3 };

function locationOfStation(st: string): PropertyLocation | null {
  const p = STATION_COORDS.get(st);
  if (!p || p.interpolated) return null;
  return { stations: [{ station: st, walk: 5, line: null, known: true }], ward: wardOfStation(st), wardSource: "station", point: { lat: p.lat, lon: p.lon }, pointSource: "station" };
}
function locationOfWard(w: string): PropertyLocation | null {
  const p = WARD_COORDS.get(w);
  if (!p) return null;
  return { stations: [], ward: w, wardSource: "address", point: { lat: p.lat, lon: p.lon }, pointSource: "ward" };
}
function nearestKm(want: AreaWant, pt: { lat: number; lon: number }): number {
  let best = Infinity;
  for (const w of want.stations) { const p = stationPoint(w.station); if (p) best = Math.min(best, distanceKm(pt, p)); }
  for (const pl of want.places) best = Math.min(best, distanceKm(pt, pl.point));
  for (const w of want.wards) { const p = wardPoint(w); if (p) best = Math.min(best, distanceKm(pt, p)); }
  return best;
}

/** 案（未接続）: 段 → 足す駅・区（純） */
export function netExtrasFor(want: AreaWant, level: ProposalLevel): { stations: string[]; wards: string[] } {
  const codes = new Set(NET_LEVEL_CODES[level]);
  const wardCodes = new Set(NET_LEVEL_WARD_CODES[level]);
  const stations: Array<{ name: string; rank: number; km: number }> = [];
  const wards: Array<{ name: string; rank: number; km: number }> = [];
  const concrete = want.any && (want.stations.length > 0 || want.places.length > 0 || want.wards.length > 0) && !want.anchors.length;
  if ((codes.size || wardCodes.size) && concrete) {
    const wantSt = new Set(want.stations.map((s) => s.station));
    for (const st of STATION_LINES.keys()) {
      if (wantSt.has(st) || want.exclude.stations.includes(st)) continue;
      const loc = locationOfStation(st);
      if (!loc || (loc.ward && want.exclude.wards.includes(loc.ward))) continue;
      const m = matchArea(want, loc);
      if (!m || !codes.has(m.code) || m.directionNg) continue;
      if (m.code === "AREA_REGION_MATCH" && !want.stations.length && !want.places.length) continue;
      stations.push({ name: st, rank: RANK[m.code] ?? 9, km: nearestKm(want, loc.point!) });
    }
    const wantWd = new Set(want.wards);
    for (const w of WARD_COORDS.keys()) {
      if (wantWd.has(w) || want.exclude.wards.includes(w)) continue;
      const loc = locationOfWard(w);
      if (!loc) continue;
      const m = matchArea(want, loc);
      if (!m || !wardCodes.has(m.code) || m.directionNg) continue;
      wards.push({ name: w, rank: RANK[m.code] ?? 9, km: nearestKm(want, loc.point!) });
    }
  }
  const byNear = (a: { rank: number; km: number }, b: { rank: number; km: number }) => a.rank - b.rank || a.km - b.km;
  const places = Math.max(1, want.stations.length + want.places.length + want.wards.length);
  return {
    stations: stations.sort(byNear).slice(0, Math.min(NET_MAX_STATIONS[level], NET_PER_PLACE[level] * places)).map((s) => s.name),
    wards: wards.sort(byNear).slice(0, NET_MAX_WARDS[level]).map((s) => s.name),
  };
}

/** お客様の条件欄の写しとブレインの材料から範囲を作る（純） */
export function proposalRangeFor(customer: { desired_area?: string | null; preferences?: string | null; other_requests?: string | null }, m: ProposalMaterials): ProposalRange {
  const want = parseAreaWant(customer.desired_area ?? null, [customer.preferences, customer.other_requests].filter(Boolean).join("\n"));
  return decideProposalRange(m, { wantStations: want.stations.map((s) => s.station), wantWards: want.wards });
}

/** 画面・ログの1行（「提案の範囲: 広げてよい — ブレイン: 安くしたい／家賃の上限は超えない」）。材料が無い時は null */
export function proposalRangeLine(r: ProposalRange | null | undefined): string | null {
  if (!r || !r.reasons.length) return null;
  const lv = r.level === "tight" ? "場所は広げない" : r.level === "broad" ? "広げて提案してよい" : "いつもの幅";
  return `提案の範囲: ${lv} — ${r.reasons.join("／")}`;
}

export const PROPOSAL_NEAR_KM = AREA_NEAR_KM;
