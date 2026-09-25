// app/lib/transit-route.ts（純関数・静的データ・DB 依存なし）
// 路線の駅の並び（osaka-geo.ts の LINES）から駅のつながりを作り、2駅の間の最短の乗り方（駅数・乗り換え・おおよその分数）を出す。
//
// 2026-09-25 竹内「通勤の部分も沿線の知識。拡張ツールの物件検索のデータベースにあるから、それ使えるなら使う」
//   決まり（おおよそ・時刻表ではない）:
//     - 1駅の分数は駅の間の距離から出す（停車 0.8分＋1km あたり 1.1分・最低 1.5分）。座標が無い時だけ路線ごとの1駅の分数
//       （拡張の build-transit-graph.js の LINE_TRAVEL_TIMES）。拡張の分数だけだと郊外で長すぎた（南海高野線 4分/駅 → 堺東〜なんば 44分。
//       実際は各停で約20分）。距離から出すと メトロ1駅 約2分・十三〜梅田 約3分・堺東〜なんば 約20分・茨木〜大阪 約19分（各停）になる
//     - 乗り換えは 5分（拡張と同じ）。直通の運転（御堂筋線→北急・JR宝塚線→東西線→学研都市線 等・osaka-geo の THROUGH_SERVICES）は乗り換えにしない
//     - 同じ名前の駅は同じ駅（「淡路」＝阪急とおおさか東線）。離れた別名の駅（梅田↔大阪↔北新地・天王寺↔阿部野橋 等）は歩き 5分の乗り換え
//     - 目的地は駅のまとまり（osaka-geo の STATION_GROUPS・梅田＝大阪・西梅田・北新地）のどれに着いても「着いた」
//     - 徒歩（物件→最寄り駅）は呼ぶ側が資料の徒歩分を足す
//
// 2026-09-25 竹内「梅田駅まで電車で一本の場合、梅田駅や大阪梅田駅に一本で通える沿線を全て理解…電車で何分以内で通える駅かも分かる」
//   → 探す仕組みは transit-core.ts（import なしの純関数）に移し、ここは osaka-geo のデータを渡すだけにした。
//     拡張（chrome-extension/osaka-transit.js）は scripts/build-osaka-transit-data.ts が同じデータ（transitData()）と同じ関数を書き出す。
import { LINES, minutesPerStop, normStation, STATION_COORDS, distanceKm, THROUGH_SERVICES, STATION_GROUPS, WALK_LINKS, ALIASES, PREFIXES } from "./osaka-geo";
import { createTransit, parseCommuteAsks, type TransitData, type TransitService, type RouteResult, type OneRideResult, type WithinStation, type TransitGroup, type CommuteAsk } from "./transit-core";
export type { RouteResult, OneRideResult, WithinStation, TransitGroup, CommuteAsk } from "./transit-core";

/** 隣の駅までの分（距離から・座標が無ければ路線の1駅の分数） */
export function hopMinutes(a: string, b: string, line: string): number {
  const pa = STATION_COORDS.get(a), pb = STATION_COORDS.get(b);
  if (!pa || !pb) return minutesPerStop(line);
  return Math.max(1.5, 0.8 + 1.1 * distanceKm(pa, pb));
}

export const TRANSFER_MINUTES = 5;
export const WALK_TRANSFER_MINUTES = 5;

/** 輪になっている路線 */
const LOOP_LINES = ["大阪環状線"];

/** 路線の並びの一部（端の駅から端の駅まで・向きはどちらでも） */
function sliceLine(line: string, from: string, to: string): string[] {
  const st = LINES[line];
  if (!st) throw new Error(`直通の運転: 路線 ${line} が無い`);
  const a = st.indexOf(normStation(from)), b = st.indexOf(normStation(to));
  if (a < 0 || b < 0) throw new Error(`直通の運転: ${line} に ${from} か ${to} が無い`);
  return a <= b ? st.slice(a, b + 1) : st.slice(b, a + 1).reverse();
}

/**
 * サーバーと拡張で使う1つのデータ（路線・隣の駅の分・直通の運転・歩きの乗り換え・駅のまとまり・座標・名前の揺れ）。
 * 拡張の osaka-transit.js はこれを scripts/build-osaka-transit-data.ts で JSON にして持つ。
 */
export function transitData(): TransitData {
  // 環状線は輪（天満→大阪がつながる）。LINES は輪を閉じない形（insideLoop の多角形・拡張の辞書と同じ）なので、つながりの側で閉じる。
  //   閉じないと 京橋→大阪 を 天王寺 回りで数えていた（2026-09-25 の目で読む監査で発見）
  const lines: Record<string, string[]> = {};
  for (const [line, st] of Object.entries(LINES)) lines[line] = LOOP_LINES.includes(line) && st.length > 2 && st[0] !== st[st.length - 1] ? [...st, st[0]] : st;
  const hops: Record<string, number[]> = {};
  for (const [line, st] of Object.entries(lines)) hops[line] = st.slice(1).map((s, i) => +hopMinutes(st[i], s, line).toFixed(2));
  const services: TransitService[] = THROUGH_SERVICES.map((sv) => {
    // 駅と「その駅へ来る区間の路線」を並べ、止まる駅だけ（stops）に絞ってから隣の駅の分を距離で出す
    const seq: Array<{ st: string; line: string }> = [];
    for (const [line, from, to] of sv.parts) {
      const seg = sliceLine(line, from, to);
      if (seq.length && seq[seq.length - 1].st !== seg[0]) throw new Error(`直通の運転 ${sv.name}: ${seq[seq.length - 1].st} と ${seg[0]} がつながらない`);
      seg.forEach((s, i) => { if (!(i === 0 && seq.length)) seq.push({ st: s, line }); });
    }
    const keep = sv.stops ? new Set(sv.stops.map(normStation)) : null;
    if (keep) for (const s of keep) if (!seq.some((x) => x.st === s)) throw new Error(`直通の運転 ${sv.name}: 止まる駅 ${s} が並びに無い`);
    const kept = keep ? seq.filter((x) => keep.has(x.st)) : seq;
    const stations = kept.map((x) => x.st);
    const lines = kept.slice(1).map((x) => x.line);
    const hs = kept.slice(1).map((x, i) => +hopMinutes(kept[i].st, x.st, x.line).toFixed(2));
    return { name: sv.name, stations, lines, hops: hs };
  });
  const coords: Record<string, [number, number]> = {};
  for (const [s, p] of STATION_COORDS) coords[s] = [p.lat, p.lon];
  return {
    lines, hops, services, walks: WALK_LINKS, groups: STATION_GROUPS, coords,
    norm: { aliases: ALIASES, prefixes: PREFIXES }, transferMinutes: TRANSFER_MINUTES, walkMinutes: WALK_TRANSFER_MINUTES,
  };
}

let _transit: ReturnType<typeof createTransit> | null = null;
/** 組み立て済みの路線のつながり（初回だけ作る） */
export function transit(): ReturnType<typeof createTransit> {
  if (!_transit) _transit = createTransit(transitData());
  return _transit;
}

/**
 * 最短の乗り方（分が同じなら乗り換えの少ない方）。どちらかの駅を知らない・つながらない時は null。
 * 同じ経路（路線・直通の運転）の隣の駅は1駅の分、経路を替えるのは乗り換え（5分・1回）、歩きの乗り換えは 5分。
 * 目的地は駅のまとまり（梅田＝大阪・西梅田・北新地）のどれに着いてもよい。
 */
export function shortestRoute(fromRaw: string, toRaw: string): RouteResult | null {
  return transit().shortestRoute(fromRaw, toRaw);
}

/** 乗り換えなしで目的地（駅のまとまり）へ行ける全部の駅（路線ごと・直通を含む）。知らない目的地は null */
export function oneRideStations(dest: string): OneRideResult | null {
  return transit().oneRideStations(dest);
}

/** 目的地まで maxMinutes 分以内（所要の目安・乗り換え5分）で行ける駅。maxTransfers の既定は 2 */
export function stationsWithin(dest: string, maxMinutes: number, opts: { maxTransfers?: number } = {}): { target: TransitGroup; stations: WithinStation[] } | null {
  return transit().stationsWithin(dest, maxMinutes, opts);
}

/** 文から「◯◯まで一本／◯分／通勤」を読む（拡張と同じ関数） */
export function commuteAsksInText(text: string | null | undefined): CommuteAsk[] {
  const t = transit();
  return parseCommuteAsks(text, t.groupOf);
}

/** 路線の短い名前（中身は transit-core.ts・拡張と同じ） */
export { shortLineName } from "./transit-core";
