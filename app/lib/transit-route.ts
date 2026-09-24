// app/lib/transit-route.ts（純関数・静的データ・DB 依存なし）
// 路線の駅の並び（osaka-geo.ts の LINES）から駅のつながりを作り、2駅の間の最短の乗り方（駅数・乗り換え・おおよその分数）を出す。
//
// 2026-09-25 竹内「通勤の部分も沿線の知識。拡張ツールの物件検索のデータベースにあるから、それ使えるなら使う」
//   決まり（おおよそ・時刻表ではない）:
//     - 1駅の分数は駅の間の距離から出す（停車 0.8分＋1km あたり 1.1分・最低 1.5分）。座標が無い時だけ路線ごとの1駅の分数
//       （拡張の build-transit-graph.js の LINE_TRAVEL_TIMES）。拡張の分数だけだと郊外で長すぎた（南海高野線 4分/駅 → 堺東〜なんば 44分。
//       実際は各停で約20分）。距離から出すと メトロ1駅 約2分・十三〜梅田 約3分・堺東〜なんば 約20分・茨木〜大阪 約19分（各停）になる
//     - 乗り換えは 5分（拡張と同じ）。直通の組（御堂筋線↔北急・東西線↔学研都市線 等）は乗り換えにしない
//     - 同じ名前の駅は同じ駅（「淡路」＝阪急とおおさか東線）。離れた別名の駅（梅田↔大阪↔北新地・天王寺↔阿部野橋 等）は歩き 5分の乗り換え
//     - 徒歩（物件→最寄り駅）は呼ぶ側が資料の徒歩分を足す
import { LINES, minutesPerStop, isThrough, normStation, STATION_LINES, STATION_COORDS, distanceKm } from "./osaka-geo";

/** 隣の駅までの分（距離から・座標が無ければ路線の1駅の分数） */
export function hopMinutes(a: string, b: string, line: string): number {
  const pa = STATION_COORDS.get(a), pb = STATION_COORDS.get(b);
  if (!pa || !pb) return minutesPerStop(line);
  return Math.max(1.5, 0.8 + 1.1 * distanceKm(pa, pb));
}

export const TRANSFER_MINUTES = 5;
export const WALK_TRANSFER_MINUTES = 5;

/** 歩いて乗り換える駅の組（同じ名前にそろえていない物） */
const WALK_LINKS: Array<[string, string]> = [
  ["梅田", "大阪"], ["梅田", "北新地"], ["大阪", "北新地"], ["梅田", "西梅田"], ["大阪", "西梅田"], ["北新地", "西梅田"],
  ["天王寺", "大阪阿部野橋"], ["天王寺", "天王寺駅前"], ["大阪阿部野橋", "阿倍野"],
  ["新今宮", "動物園前"], ["新今宮", "新今宮駅前"], ["動物園前", "新今宮駅前"], ["岸里玉出", "岸里"], ["岸里玉出", "玉出"],
  ["大阪上本町", "谷町九丁目"], ["南森町", "大阪天満宮"], ["扇町", "天満"], ["北浜", "なにわ橋"], ["淀屋橋", "大江橋"], ["肥後橋", "渡辺橋"],
  ["新福島", "福島"], ["海老江", "野田阪神"], ["野田", "玉川"], ["住吉", "住吉大社"], ["住吉鳥居前", "住吉大社"], ["恵美須町", "今宮戎"],
  ["中津", "梅田"], ["桜川", "なんば"], ["日本橋", "なんば"], ["今池", "新今宮"], ["天下茶屋", "北天下茶屋"],
];

export type RouteResult = {
  from: string;
  to: string;
  /** 乗っている分＋乗り換えの分（物件からの徒歩は含まない） */
  minutes: number;
  stops: number;
  transfers: number;
  /** 乗った路線（順） */
  lines: string[];
};

type Edge = { to: string; line: string; minutes: number; kind: "ride" | "walk" };
const ADJ: Map<string, Edge[]> = (() => {
  const m = new Map<string, Edge[]>();
  const add = (a: string, e: Edge) => { const arr = m.get(a) ?? []; arr.push(e); m.set(a, arr); };
  for (const [line, st] of Object.entries(LINES)) {
    for (let i = 1; i < st.length; i++) {
      if (st[i - 1] === st[i]) continue;
      const mins = hopMinutes(st[i - 1], st[i], line);
      add(st[i - 1], { to: st[i], line, minutes: mins, kind: "ride" });
      add(st[i], { to: st[i - 1], line, minutes: mins, kind: "ride" });
    }
  }
  for (const [a, b] of WALK_LINKS) {
    if (!STATION_LINES.has(a) || !STATION_LINES.has(b)) continue;
    add(a, { to: b, line: "徒歩", minutes: WALK_TRANSFER_MINUTES, kind: "walk" });
    add(b, { to: a, line: "徒歩", minutes: WALK_TRANSFER_MINUTES, kind: "walk" });
  }
  return m;
})();

/** 目的地の言い方 → 着いたとみなす駅（梅田＝大阪・北新地・西梅田も・なんば＝日本橋は含めない） */
const TARGET_HUBS: Record<string, string[]> = {
  梅田: ["梅田", "大阪", "北新地", "西梅田"],
  大阪: ["大阪", "梅田", "北新地", "西梅田"],
  天王寺: ["天王寺", "大阪阿部野橋"],
  三ノ宮: ["三ノ宮"],
};

/**
 * 最短の乗り方（分が同じなら乗り換えの少ない方）。どちらかの駅を知らない・つながらない時は null。
 * 状態＝（駅・乗っている路線）。同じ路線の隣の駅は1駅の分、路線を替えるのは乗り換え（直通は 0分・数えない）、歩きの乗り換えは 5分。
 */
export function shortestRoute(fromRaw: string, toRaw: string): RouteResult | null {
  const from = normStation(fromRaw), to = normStation(toRaw);
  if (!STATION_LINES.has(from) || !STATION_LINES.has(to)) return null;
  const goals = new Set((TARGET_HUBS[to] ?? [to]).filter((s) => STATION_LINES.has(s)));
  if (goals.has(from)) return { from, to, minutes: 0, stops: 0, transfers: 0, lines: [] };
  type State = { st: string; line: string | null; min: number; tr: number; stops: number; lines: string[] };
  const best = new Map<string, { min: number; tr: number }>();
  const queue: State[] = [{ st: from, line: null, min: 0, tr: 0, stops: 0, lines: [] }];
  const better = (a: { min: number; tr: number }, b: { min: number; tr: number } | undefined) => !b || a.min < b.min - 1e-9 || (Math.abs(a.min - b.min) < 1e-9 && a.tr < b.tr);
  while (queue.length) {
    // 小さい順に取り出す（駅は 500 程度なので線形で足りる）
    let bi = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].min < queue[bi].min || (queue[i].min === queue[bi].min && queue[i].tr < queue[bi].tr)) bi = i;
    const cur = queue.splice(bi, 1)[0];
    if (goals.has(cur.st)) return { from, to, minutes: Math.round(cur.min), stops: cur.stops, transfers: cur.tr, lines: cur.lines };
    const key = `${cur.st}|${cur.line ?? ""}`;
    const seen = best.get(key);
    if (seen && (seen.min < cur.min - 1e-9 || (Math.abs(seen.min - cur.min) < 1e-9 && seen.tr < cur.tr))) continue;
    for (const e of ADJ.get(cur.st) ?? []) {
      let min = cur.min + e.minutes, tr = cur.tr, stops = cur.stops, line: string | null = cur.line, lines = cur.lines;
      if (e.kind === "walk") {
        if (cur.line == null) { /* 出発駅で歩いて別の駅へ（梅田→大阪）: 乗り換えに数えない */ } else tr += 1;
        line = null;
      } else {
        stops += 1;
        if (cur.line != null && cur.line !== e.line) {
          if (!isThrough(cur.line, e.line)) { min += TRANSFER_MINUTES; tr += 1; }
        } else if (cur.line == null && cur.lines.length > 0) {
          // 歩きの乗り換えの後に乗る（歩いた分で数えた）
        }
        line = e.line;
        if (lines[lines.length - 1] !== e.line) lines = [...lines, e.line];
      }
      const k = `${e.to}|${line ?? ""}`;
      const cand = { min, tr };
      if (!better(cand, best.get(k))) continue;
      best.set(k, cand);
      queue.push({ st: e.to, line, min, tr, stops, lines });
    }
  }
  return null;
}

/** 路線の短い名前（「大阪市高速軌道御堂筋線」→「御堂筋線」・「東海道本線」→「JR京都線」） */
export function shortLineName(line: string): string {
  return line.replace(/^大阪市高速軌道/, "").replace(/^阪急電鉄/, "阪急").replace(/^阪神電鉄(?:阪神)?/, "阪神").replace(/^京阪電気鉄道/, "京阪").replace(/^南海電鉄/, "南海")
    .replace(/^東海道本線$/, "JR京都線").replace(/^関西本線$/, "大和路線").replace(/^片町線$/, "学研都市線").replace(/^近鉄難波・奈良線$/, "近鉄奈良線");
}
