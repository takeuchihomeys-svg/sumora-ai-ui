// app/lib/proposal-range.ts — このお客様に「条件から広げて提案してよい範囲」（ブレインの判断を材料に・純関数・DB/fetch/LLM 無し）
//
// 2026-10-13 竹内さん: 「ブレインとぶつかる変な決まり・昔の制限を根本からブレイン基準に。規則は候補の網と安全の線だけ」
//   訂正（同日）「広げて検索の部分ではなくて、お客さんに広げて提案できるところの範囲」
//   設計知見 P0 9eb6aa9c（判断はすべてブレイン基準）・P1 0593a0aa（判断も表示も次の行動もブレインが決めた事を使う・ブレインの入力の経路に答えを戻さない）・
//   P1 3b508208（物差し: 物件選び・資料は竹内さん＋スタッフの送信／文は竹内さんの LINE だけ）・P1 a8f86224（判定の点は広げた幅を帯にする）
//
// ■ 何を決めるか
//   お客様ごとに「どこまでなら広げて提案してよいか」を段（ProposalLevel）と軸ごとの可否で決め、判定（property-brain.judgeProperty）の点・👑・保留に使う。
//   材料はブレインが毎回の判断で書いた物（conversations.suggested_aix_meta の customer_mindset・condition_change_type）と、
//   お客様の言葉から作った記録（requirement_strength・決め手の条件 closing-target の型と気に入った部屋の駅）だけ。ここで発言を読まない（ブレインとぶつけない）。
//
// ■ 実送信の当て直し（scripts/audit-proposal-range.ts・120日・竹内さん＋スタッフが送った物件 × その後の🌟・反応・内覧・申込）
//   エリアの帯ごとの刺さり: 希望の駅 23%／2駅 21%／2km 20%／範囲 24%／4km・隣の区 17%／遠い（4km超）16%。
//   ＝点の帯の中（2駅・2km・範囲・隣の区）は希望どおりと同じくらい刺さる。遠い物件も 0 ではない（16%）＝「広げて提案してよいお客様」がいる。
//   ただし「前に広げた物件が刺さったか」で次の刺さりは変わらない（20%／19%）＝反応の数は物差しとして弱い。段はブレインの判断（状態・決め手）で決める。
//
// ■ 段（ProposalLevel）
//   tight    … 場所をはっきり言っている（エリアが「必ず」・ブレインの決め手の残りが「立地・駅」・決め手の条件が「駅近」・ブレインがエリアの言い直しと読んだ）
//              → 隣の区・4km（AREA_CLOSE）・遠い（AREA_FAR）は「提案の範囲の外」＝保留（PROPOSAL_AREA_OUT −10）。2駅・2km・範囲は情報の減点（PROPOSAL_AREA_EDGE −3）
//   standard … 材料が無い時の既定（今までの点のまま）
//   broad    … 広げて提案してよい（ブレイン: 急いでいる・安くしたい／決め手の残りが家賃・初期費用・広さ・築年で別の物件で解く／条件を緩めた／
//              エリアが「できれば」／気に入った部屋が希望の場所の外）→ 遠い物件の −3 を戻す（PROPOSAL_AREA_WIDE_OK +3）・隣の区 +2 に +2
//   tight と broad の両方の材料がある時は tight（場所をはっきり言っている方を守る＝安全の線）。
// ■ 軸ごと
//   家賃: ブレインの決め手の残りが家賃・状態が安くしたい・決め手の条件が家賃を下げる → 上限を超える物件（RENT_WIDE・RENT_SLIGHTLY_OVER）は提案の範囲の外＝保留（PROPOSAL_RENT_OUT）
//         （家賃が「必ず」は requirement-strength の RENT_OVER_MUST が見るのでここでは見ない）
//   築年: 決め手の条件が築浅・決め手の残りが築年 → 築年の広げた帯（BUILDING_AGE_WIDE）を情報の減点（PROPOSAL_AGE_OUT −5）
//   広さ・間取り: 決め手の条件が広さ・決め手の残りが広さ → 広さの −10㎡の帯（30㎡以上）と「部屋数が1つ少ない広い LDK」を使わない（今までの保留）
//
// 戻す: 環境変数 PROPOSAL_RANGE=off（判定は今までの点のまま）
import { matchArea, parseAreaWant, AREA_NEAR_KM, type AreaWant, type PropertyLocation } from "./area-want";
import { STATION_COORDS, STATION_LINES, WARD_COORDS, wardOfStation, distanceKm, stationPoint, wardPoint, normStation } from "./osaka-geo";

import { PROPOSAL_RANGE_VERSION, type ProposalLevel, type ProposalRange } from "./proposal-range-codes";
export { PROPOSAL_RANGE_VERSION, proposalRangeEnabled, proposalRangeCodes, wideSqmMargin, FEWER_ROOM_LDK_MIN_SQM, PROPOSAL_POINTS, PROPOSAL_JA, PROPOSAL_HOLD_CODES, type ProposalLevel, type ProposalRange } from "./proposal-range-codes";

/** ブレインの判断と、お客様の言葉から作った記録（どれも無くてよい） */
export type ProposalMaterials = {
  /** ブレインの customer_mindset.state（刺さっている／急いでいる／安くしたい…） */
  brainState?: string | null;
  /** ブレインの customer_mindset.decideGap（決め手の残り） */
  brainGap?: { point?: string | null; solve?: string | null } | null;
  /** ブレインの condition_change_type（condition_relax／area_change／equip_add…） */
  conditionChangeType?: string | null;
  /** property_customers.requirement_strength（area・rent_max の強さ） */
  areaStrength?: string | null;
  rentStrength?: string | null;
  /** 決め手の条件（closing-target）の型（rent_lower・closer・wider・newer…）。found（もう見つかった）は渡さない */
  closingKinds?: ReadonlyArray<string> | null;
  /** 気に入った部屋（決め手の条件の favorite）の駅。希望の場所の外なら、お客様はその場所を受け入れている */
  favoriteStations?: ReadonlyArray<string> | null;
};

const TIGHT_GAP_POINTS = new Set(["立地・駅"]);
const BROAD_GAP_POINTS = new Set(["家賃", "初期費用", "広さ", "築年"]);
const BROAD_STATES = new Set(["急いでいる", "安くしたい"]);
const BROAD_CLOSING = new Set(["rent_lower", "initial_cost", "wider", "newer"]);
const CLOSING_JA: Record<string, string> = { rent_lower: "家賃を下げる", initial_cost: "初期費用", wider: "広さ", newer: "築年", closer: "駅近" };

/**
 * 提案してよい範囲（純）。opts.wantStations／wantWards は希望の駅・区（気に入った部屋が希望の場所の外かを見るだけ）
 */
export function decideProposalRange(m: ProposalMaterials, opts: { wantStations?: ReadonlyArray<string>; wantWards?: ReadonlyArray<string> } = {}): ProposalRange {
  const tight: string[] = [];
  const broad: string[] = [];
  const gapPoint = m.brainGap?.point ?? null;
  const gapSolve = m.brainGap?.solve ?? null;
  const closing = new Set((m.closingKinds ?? []).map(String));
  if (m.areaStrength === "must") tight.push("エリアは必ず");
  if (gapPoint && TIGHT_GAP_POINTS.has(gapPoint)) tight.push(`ブレイン: 決め手の残りが${gapPoint}`);
  if (closing.has("closer")) tight.push("決め手の条件: 駅近");
  if (m.conditionChangeType === "area_change") tight.push("ブレイン: エリアの言い直し");

  if (m.brainState && BROAD_STATES.has(m.brainState)) broad.push(`ブレイン: ${m.brainState}`);
  if (gapPoint && BROAD_GAP_POINTS.has(gapPoint) && (gapSolve === "c" || gapSolve == null)) broad.push(`ブレイン: 決め手の残りが${gapPoint}（別の物件で解く）`);
  if (m.conditionChangeType === "condition_relax") broad.push("ブレイン: 条件を緩めた");
  for (const k of closing) if (BROAD_CLOSING.has(k)) broad.push(`決め手の条件: ${CLOSING_JA[k] ?? k}`);
  if (m.areaStrength === "nice") broad.push("エリアはできれば");
  const wantSt = new Set(opts.wantStations ?? []);
  const wantWd = new Set(opts.wantWards ?? []);
  const favOut = (m.favoriteStations ?? []).map((s) => normStation(s)).find((s) => s && !wantSt.has(s) && !(wardOfStation(s) && wantWd.has(wardOfStation(s) as string)));
  if (favOut && (wantSt.size || wantWd.size)) broad.push(`気に入った部屋の駅（${favOut}）が希望の場所の外`);

  const level: ProposalLevel = tight.length ? "tight" : broad.length ? "broad" : "standard";
  const rentTight = gapPoint === "家賃" || m.brainState === "安くしたい" || closing.has("rent_lower");
  const ageTight = gapPoint === "築年" || closing.has("newer");
  const sizeTight = gapPoint === "広さ" || closing.has("wider");
  const reasons = tight.length ? [...tight, ...(broad.length ? [`（広げる材料もあるが場所を守る: ${broad.join("・")}）`] : [])] : broad.length ? broad : [];
  if (rentTight) reasons.push("家賃の上限は超えない（家賃が決め手）");
  if (ageTight) reasons.push("築年は広げない（築年が決め手）");
  if (sizeTight) reasons.push("広さ・部屋数は広げない（広さが決め手）");
  return { v: 1, version: PROPOSAL_RANGE_VERSION, level, rentOver: !rentTight, ageWide: !ageTight, sizeWide: !sizeTight, reasons };
}

/** 材料が無い時の範囲（今までの点のまま＋既定の広さ・間取りの帯） */
export const DEFAULT_PROPOSAL_RANGE: ProposalRange = { v: 1, version: PROPOSAL_RANGE_VERSION, level: "standard", rentOver: true, ageWide: true, sizeWide: true, reasons: [] };

// ─── 案: 検索の網（今は使っていない・報告の案） ─────────────────────────────

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
