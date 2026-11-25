/**
 * 所在地 ↔ 沿線・駅 の XOR（並行して入れない・どちらか一方）
 *
 * 2026-11-23 竹内さん「入れるときと同じ発想で所在地絞り込みと沿線　駅絞り込みが
 *   並行して入っていることはないので、ここはどちらかになる」
 *
 * 拡張 page-script の `_axWantPlaceMode` / `_axApplyPlaceXor` / `decideLocationMode` と同型。
 * テストと customer_think が同じ表を使う（理解の抜けを止める）。
 */

export type PlaceXorMode = "area" | "station" | "route" | "none";

export type PlaceXorCond = {
  area_mode?: string | null;
  city_codes?: Array<string | number> | null;
  detail_ward?: string | null;
  station_names?: string[] | null;
  route_ids?: Array<string | number> | null;
};

function hasWard(c: PlaceXorCond): boolean {
  return !!((c.city_codes && c.city_codes.length > 0) || c.detail_ward);
}
function hasStation(c: PlaceXorCond): boolean {
  return !!(c.station_names && c.station_names.length > 0);
}
function hasRoutes(c: PlaceXorCond): boolean {
  return !!(c.route_ids && c.route_ids.length > 0);
}

/**
 * 今回入れる場所モードを1つだけ返す（XOR）。
 * area_mode 明示を優先。auto は区があれば所在地、次に駅、次に沿線。
 */
export function decidePlaceXor(c: PlaceXorCond | null | undefined): PlaceXorMode {
  const x = c || {};
  if (x.area_mode === "ward") {
    if (hasWard(x)) return "area";
    if (hasStation(x)) return "station";
    if (hasRoutes(x)) return "route";
    return "none";
  }
  if (x.area_mode === "station") {
    if (hasStation(x)) return "station";
    if (hasRoutes(x)) return "route";
    if (hasWard(x)) return "area";
    return "none";
  }
  // auto: 区優先（駅名が付いていても所在地で入れる録画正本）
  if (hasWard(x)) return "area";
  if (hasStation(x)) return "station";
  if (hasRoutes(x)) return "route";
  return "none";
}

export function placeXorLabel(mode: PlaceXorMode): string {
  if (mode === "area") return "所在地絞り込みだけ";
  if (mode === "station") return "沿線・駅絞り込みだけ（駅）";
  if (mode === "route") return "沿線・駅絞り込みだけ（沿線）";
  return "場所なし";
}

/** 負けた軸を消した条件と、消した理由 */
export function applyPlaceXorSuppress<T extends PlaceXorCond>(
  cond: T,
  mode: PlaceXorMode = decidePlaceXor(cond),
): { cond: T; mode: PlaceXorMode; label: string; drop: string[] } {
  const next = { ...cond } as T;
  const beforeSt = hasStation(cond);
  const beforeRt = hasRoutes(cond);
  const beforeWd = hasWard(cond);
  const drop: string[] = [];
  if (mode === "area") {
    (next as PlaceXorCond).station_names = [];
    (next as PlaceXorCond).route_ids = [];
    if (beforeSt || beforeRt) drop.push("沿線・駅は入れない");
  } else if (mode === "station" || mode === "route") {
    (next as PlaceXorCond).city_codes = [];
    (next as PlaceXorCond).detail_ward = null;
    if (beforeWd) drop.push("所在地は入れない");
  }
  return { cond: next, mode, label: placeXorLabel(mode), drop };
}

/** 画面上の区残・駅残が同時なら XOR 違反 */
export function isPlaceXorViolation(wardN: number, stationN: number): boolean {
  return (Number(wardN) || 0) > 0 && (Number(stationN) || 0) > 0;
}
