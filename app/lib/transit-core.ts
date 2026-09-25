// app/lib/transit-core.ts（純関数・import なし・DB 依存なし）
// 大阪の路線のつながりを「データ（TransitData）」から組み立て、乗り換えなしで行ける駅・◯分以内の駅・最短の乗り方を出す。
//
// 2026-09-25 竹内「地図の部分や沿線の部分の位置関係の強化は拡張ツールでも理解できるようにする。例えば梅田駅まで電車で一本の場合、
//   梅田駅や大阪梅田駅に一本で通える沿線を全て理解して、そこの駅を理解していれば分かるし、位置関係も理解していれば、
//   電車で何分以内で通える駅かも分かる」
//
// ■ サーバーと拡張で同じ関数
//   このファイルは import を持たない。サーバー（app/lib/transit-route.ts）は osaka-geo のデータで createTransit を呼び、
//   拡張（chrome-extension/osaka-transit.js・self.AxlxOsakaTransit）は scripts/build-osaka-transit-data.ts が
//   このファイルを JS に変換して同じデータと一緒に書き出す（手で二重に持たない。直す時はここと osaka-geo.ts を直して生成し直す）。
//
// ■ 決まり（おおよそ・時刻表ではない）
//   - 乗る「経路」は路線（lines）と直通の運転（services＝御堂筋線→北急・JR宝塚線→東西線→学研都市線 等を1本に並べた物）。
//     同じ経路に乗っている間は乗り換えにしない。経路を替えると乗り換え（transferMinutes 分・1回）。
//   - 駅のまとまり（groups＝梅田／大阪／西梅田／北新地 等）は「着いた」と同じに扱う（目的地の全部の駅から探す）。
//   - 歩いて乗り換える駅の組（walks）は walkMinutes 分・乗り換え1回（出発の駅で歩くのは乗り換えに数えない）。続けて2回は歩かない。
//   - 隣の駅までの分は、データを作る側（osaka-geo の駅の間の距離）で hops に入れておく。

export type TransitService = {
  /** 「御堂筋線→北急」のような名前 */
  name: string;
  /** 駅の並び（端から端） */
  stations: string[];
  /** 隣の駅の間ごとの、元の路線（stations.length − 1 個） */
  lines: string[];
  /** 隣の駅の間ごとの分（stations.length − 1 個） */
  hops: number[];
};

export type TransitData = {
  /** 路線 → 駅の並び（そろえた名前） */
  lines: Record<string, string[]>;
  /** 路線 → 隣の駅の間ごとの分（並びと同じ順・駅の数 − 1 個） */
  hops: Record<string, number[]>;
  /** 直通の運転（乗り換えなしで続けて乗れる並び） */
  services: TransitService[];
  /** 歩いて乗り換える駅の組 */
  walks: Array<[string, string]>;
  /** 駅のまとまり（代表の名前 → 駅）。乗り換えで同じ場所として扱う */
  groups: Record<string, string[]>;
  /** 駅の座標 [緯度, 経度]（按分を含む） */
  coords: Record<string, [number, number]>;
  /** 名前の揺れ（normStationWith に渡す） */
  norm: { aliases: Record<string, string>; prefixes: string[] };
  transferMinutes: number;
  walkMinutes: number;
};

// ───────────────────────── 名前の揺れ ─────────────────────────

const KANJI_NUM: Record<string, string> = { "1": "一", "2": "二", "3": "三", "4": "四", "5": "五", "6": "六", "7": "七", "8": "八", "9": "九" };

/** 駅名をそろえる（全角半角・末尾の「駅」・会社名の頭・ヶ/ケ・「4丁目」・略称）。知らない名前もそろえた形で返す。空は "" */
export function normStationWith(raw: string | null | undefined, aliases: Record<string, string>, prefixes: string[], has: (s: string) => boolean): string {
  let s = String(raw ?? "").normalize("NFKC").replace(/[\s　]/g, "").replace(/[「」『』]/g, "");
  s = s.replace(/[（(][^）)]*[）)]$/, "").replace(/駅$/, "");
  s = s.replace(/[ヶがケ](?=[丘崎谷原森浦])/g, "ケ").replace(/ヶ/g, "ケ");
  s = s.replace(/([0-9])丁目/g, (_m, d: string) => `${KANJI_NUM[d] ?? d}丁目`);
  if (aliases[s]) return aliases[s];
  if (has(s)) return s;
  for (const p of prefixes) {
    if (s.startsWith(p) && s.length > p.length) {
      const rest = s.slice(p.length).replace(/^[・\-]/, "");
      if (aliases[rest]) return aliases[rest];
      if (has(rest)) return rest;
    }
  }
  const noKey = s.replace(/の/g, "ノ");
  if (has(noKey)) return noKey;
  const noKey2 = s.replace(/ノ/g, "の");
  if (has(noKey2)) return noKey2;
  return s;
}

/** 路線の短い名前（「大阪市高速軌道御堂筋線」→「御堂筋線」・「東海道本線」→「JR京都線」）。画面の表示用 */
export function shortLineName(line: string): string {
  return line.replace(/^大阪市高速軌道/, "").replace(/^阪急電鉄/, "阪急").replace(/^阪神電鉄(?:阪神)?/, "阪神").replace(/^京阪電気鉄道/, "京阪").replace(/^南海電鉄/, "南海")
    .replace(/^東海道本線$/, "JR京都線").replace(/^関西本線$/, "大和路線").replace(/^片町線$/, "学研都市線").replace(/^近鉄難波・奈良線$/, "近鉄奈良線");
}

// ───────────────────────── 結果の型 ─────────────────────────

export type TransitGroup = { key: string; members: string[] };

export type OneRideRoute = {
  /** 路線または直通の運転の名前 */
  route: string;
  kind: "line" | "service";
  /** 乗る元の路線（直通は複数） */
  lines: string[];
  /** 目的地のまとまりのうち、この経路が通る駅 */
  via: string[];
  /** この経路で乗り換えなしに行ける駅（目的地のまとまりの駅は除く・並び順） */
  stations: string[];
};

export type OneRideResult = {
  target: TransitGroup;
  routes: OneRideRoute[];
  /** 乗り換えなしで行ける全部の駅（重複なし）と、乗れる経路 */
  stations: Array<{ station: string; routes: string[] }>;
};

export type WithinStation = {
  station: string;
  /** 乗っている分＋乗り換えの分（物件から駅までの徒歩は含まない） */
  minutes: number;
  transfers: number;
  stops: number;
  /** 乗る元の路線（順・目的地の側から見た順ではなく、この駅から目的地へ向かう順） */
  lines: string[];
  /** 着く目的地の駅 */
  to: string;
};

export type RouteResult = {
  from: string;
  to: string;
  minutes: number;
  stops: number;
  transfers: number;
  lines: string[];
};

// ───────────────────────── 小さな優先度付きの列 ─────────────────────────

type Item = { min: number; tr: number };
function makeHeap<T extends Item>() {
  const a: T[] = [];
  const less = (x: T, y: T) => x.min < y.min - 1e-9 || (Math.abs(x.min - y.min) < 1e-9 && x.tr < y.tr);
  return {
    get size() { return a.length; },
    push(v: T) {
      a.push(v);
      let i = a.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (!less(a[i], a[p])) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
    },
    pop(): T | undefined {
      if (!a.length) return undefined;
      const top = a[0], last = a.pop()!;
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && less(a[l], a[m])) m = l;
          if (r < a.length && less(a[r], a[m])) m = r;
          if (m === i) break;
          [a[i], a[m]] = [a[m], a[i]]; i = m;
        }
      }
      return top;
    },
  };
}

// ───────────────────────── 組み立て ─────────────────────────

type Route = { name: string; kind: "line" | "service"; stations: string[]; lines: string[]; hops: number[] };
type Edge = { to: string; route: number; line: string; minutes: number } | { to: string; route: -1; line: "徒歩"; minutes: number };

export type Transit = ReturnType<typeof createTransit>;

export function createTransit(data: TransitData) {
  const index = new Set<string>();
  for (const st of Object.values(data.lines)) for (const s of st) index.add(s);
  const normStation = (raw: string | null | undefined) => normStationWith(raw, data.norm.aliases, data.norm.prefixes, (s) => index.has(s));

  const routes: Route[] = [];
  for (const [name, st] of Object.entries(data.lines)) {
    routes.push({ name, kind: "line", stations: st, lines: st.slice(1).map(() => name), hops: data.hops[name] ?? st.slice(1).map(() => 2.5) });
  }
  for (const sv of data.services) routes.push({ name: sv.name, kind: "service", stations: sv.stations, lines: sv.lines, hops: sv.hops });

  const adj = new Map<string, Edge[]>();
  const add = (a: string, e: Edge) => { const arr = adj.get(a); if (arr) arr.push(e); else adj.set(a, [e]); };
  routes.forEach((r, ri) => {
    for (let i = 1; i < r.stations.length; i++) {
      const a = r.stations[i - 1], b = r.stations[i];
      if (a === b) continue;
      const m = r.hops[i - 1];
      add(a, { to: b, route: ri, line: r.lines[i - 1], minutes: m });
      add(b, { to: a, route: ri, line: r.lines[i - 1], minutes: m });
    }
  });
  const walkPairs = new Set<string>();
  const addWalk = (a: string, b: string) => {
    if (a === b || !index.has(a) || !index.has(b)) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (walkPairs.has(k)) return;
    walkPairs.add(k);
    add(a, { to: b, route: -1, line: "徒歩", minutes: data.walkMinutes });
    add(b, { to: a, route: -1, line: "徒歩", minutes: data.walkMinutes });
  };
  for (const [a, b] of data.walks) addWalk(a, b);
  for (const members of Object.values(data.groups)) for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) addWalk(members[i], members[j]);

  const memberOf = new Map<string, string>();
  for (const [key, members] of Object.entries(data.groups)) for (const m of members) if (!memberOf.has(m)) memberOf.set(m, key);

  /** 駅名・まとまりの名前 → まとまり（知らない駅は null・まとまりが無い駅はその駅だけ） */
  function groupOf(word: string | null | undefined): TransitGroup | null {
    const raw = String(word ?? "").normalize("NFKC").replace(/[\s　]/g, "").replace(/駅$/, "");
    if (data.groups[raw]) return { key: raw, members: data.groups[raw].filter((s) => index.has(s)) };
    const s = normStation(raw);
    if (!index.has(s)) return null;
    const key = memberOf.get(s);
    if (key) return { key, members: data.groups[key].filter((x) => index.has(x)) };
    return { key: s, members: [s] };
  }

  function isKnownStation(word: string | null | undefined): boolean {
    return index.has(normStation(word));
  }

  /** 駅 → 通る路線 */
  function linesOf(station: string): string[] {
    const s = normStation(station);
    return Object.entries(data.lines).filter(([, st]) => st.includes(s)).map(([l]) => l);
  }

  /**
   * 乗り換えなしで目的地（まとまり）へ行ける駅（路線ごと・直通の運転を含む）。
   * 目的地を知らない時は null。
   */
  function oneRideStations(dest: string): OneRideResult | null {
    const target = groupOf(dest);
    if (!target) return null;
    const goal = new Set(target.members);
    const out: OneRideRoute[] = [];
    const byStation = new Map<string, string[]>();
    for (const r of routes) {
      const via = r.stations.filter((s) => goal.has(s));
      if (!via.length) continue;
      const stations = r.stations.filter((s, i, arr) => !goal.has(s) && arr.indexOf(s) === i);
      out.push({ route: r.name, kind: r.kind, lines: [...new Set(r.lines)], via: [...new Set(via)], stations });
      for (const s of stations) {
        const a = byStation.get(s) ?? [];
        if (!a.includes(r.name)) a.push(r.name);
        byStation.set(s, a);
      }
    }
    return { target, routes: out, stations: [...byStation].map(([station, rs]) => ({ station, routes: rs })) };
  }

  type State = Item & { st: string; route: number; walked: boolean; stops: number; lines: string[]; origin: string };

  /** 状態の移り方（乗る・乗り換える・歩く）。shortestRoute と stationsWithin で同じ物を使う */
  function* nextStates(cur: State): Generator<State> {
    for (const e of adj.get(cur.st) ?? []) {
      if (e.route === -1) {
        if (cur.walked) continue; // 続けて歩かない
        const atStart = cur.route === -1 && cur.stops === 0;
        yield { st: e.to, route: -1, walked: true, min: cur.min + e.minutes, tr: cur.tr + (atStart ? 0 : 1), stops: cur.stops, lines: cur.lines, origin: cur.origin };
        continue;
      }
      let min = cur.min + e.minutes, tr = cur.tr;
      if (cur.route !== -1 && cur.route !== e.route) { min += data.transferMinutes; tr += 1; }
      const lines = cur.lines[cur.lines.length - 1] === e.line ? cur.lines : [...cur.lines, e.line];
      yield { st: e.to, route: e.route, walked: false, min, tr, stops: cur.stops + 1, lines, origin: cur.origin };
    }
  }

  /** 2駅の間の最短の乗り方（分が同じなら乗り換えの少ない方）。to はまとまりの全部の駅を「着いた」とする */
  function shortestRoute(fromRaw: string, toRaw: string): RouteResult | null {
    const from = normStation(fromRaw), to = normStation(toRaw);
    if (!index.has(from) || !index.has(to)) return null;
    const g = groupOf(to);
    const goals = new Set(g ? g.members : [to]);
    if (goals.has(from)) return { from, to, minutes: 0, stops: 0, transfers: 0, lines: [] };
    const best = new Map<string, Item>();
    const heap = makeHeap<State>();
    heap.push({ st: from, route: -1, walked: false, min: 0, tr: 0, stops: 0, lines: [], origin: from });
    while (heap.size) {
      const cur = heap.pop()!;
      if (goals.has(cur.st)) return { from, to, minutes: Math.round(cur.min), stops: cur.stops, transfers: cur.tr, lines: cur.lines };
      const key = `${cur.st}|${cur.route}|${cur.walked ? 1 : 0}`;
      const seen = best.get(key);
      if (seen && (seen.min < cur.min - 1e-9 || (Math.abs(seen.min - cur.min) < 1e-9 && seen.tr < cur.tr))) continue;
      for (const nx of nextStates(cur)) {
        const k = `${nx.st}|${nx.route}|${nx.walked ? 1 : 0}`;
        const b = best.get(k);
        if (b && !(nx.min < b.min - 1e-9 || (Math.abs(nx.min - b.min) < 1e-9 && nx.tr < b.tr))) continue;
        best.set(k, { min: nx.min, tr: nx.tr });
        heap.push(nx);
      }
    }
    return null;
  }

  /**
   * 目的地（まとまり）まで maxMinutes 分以内で行ける駅（所要の目安・乗り換えの回数・乗る路線）。
   * maxTransfers（既定 2）を超える乗り方は数えない。目的地のまとまりの駅は含めない。分の短い順。
   */
  function stationsWithin(dest: string, maxMinutes: number, opts: { maxTransfers?: number } = {}): { target: TransitGroup; stations: WithinStation[] } | null {
    const target = groupOf(dest);
    if (!target) return null;
    const maxT = opts.maxTransfers ?? 2;
    const goal = new Set(target.members);
    // 状態は（駅・経路・歩いた直後・乗り換えの回数）。回数ごとに分けて持つので「乗り換え0回なら35分・1回なら25分」の両方を残せる
    const best = new Map<string, number>();
    const result = new Map<string, WithinStation>();
    const heap = makeHeap<State>();
    for (const m of target.members) heap.push({ st: m, route: -1, walked: false, min: 0, tr: 0, stops: 0, lines: [], origin: m });
    while (heap.size) {
      const cur = heap.pop()!;
      const key = `${cur.st}|${cur.route}|${cur.walked ? 1 : 0}|${cur.tr}`;
      const seen = best.get(key);
      if (seen !== undefined && seen < cur.min - 1e-9) continue;
      if (!goal.has(cur.st) && cur.stops > 0) {
        const prev = result.get(cur.st);
        if (!prev || cur.min < prev.minutes - 1e-9 || (Math.abs(cur.min - prev.minutes) < 1e-9 && cur.tr < prev.transfers)) {
          result.set(cur.st, { station: cur.st, minutes: cur.min, transfers: cur.tr, stops: cur.stops, lines: [...cur.lines].reverse(), to: cur.origin });
        }
      }
      for (const nx of nextStates(cur)) {
        if (nx.min > maxMinutes + 1e-9 || nx.tr > maxT) continue;
        const k = `${nx.st}|${nx.route}|${nx.walked ? 1 : 0}|${nx.tr}`;
        const b = best.get(k);
        if (b !== undefined && b <= nx.min + 1e-9) continue;
        best.set(k, nx.min);
        heap.push(nx);
      }
    }
    const stations = [...result.values()]
      .map((r) => ({ ...r, minutes: Math.round(r.minutes) }))
      .filter((r) => r.minutes <= maxMinutes)
      .sort((a, b) => a.minutes - b.minutes || a.transfers - b.transfers || a.station.localeCompare(b.station, "ja"));
    return { target, stations };
  }

  /** 2駅の間の直線の距離（km）。座標の無い駅は null */
  function distanceKmBetween(a: string, b: string): number | null {
    const pa = data.coords[normStation(a)], pb = data.coords[normStation(b)];
    if (!pa || !pb) return null;
    const R = 6371, rad = Math.PI / 180;
    const dLat = (pb[0] - pa[0]) * rad, dLon = (pb[1] - pa[1]) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(pa[0] * rad) * Math.cos(pb[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }

  return { normStation, groupOf, isKnownStation, linesOf, oneRideStations, stationsWithin, shortestRoute, distanceKmBetween, routeNames: routes.map((r) => r.name) };
}

// ───────────────────────── お客様の文から「◯◯まで一本／◯分／通勤」を読む ─────────────────────────

export type CommuteAsk = {
  /** 目的地のまとまりの代表の名前 */
  target: string;
  /** 書かれていた目的地の言い方 */
  word: string;
  /** 「一本・乗り換えなし・直通」 */
  oneRide: boolean;
  /** 「◯分以内」（無ければ null） */
  minutes: number | null;
  /** 読んだ文の一部 */
  source: string;
  /** 文の中の位置（最初に書かれた所・並びに使う） */
  index: number;
};

/** 町名の後ろに付きやすい2字の駅名（「川俣本町」「東野田町」「西清水」）。前が漢字の時は駅にしない */
export const TOWN_SUFFIX_STATIONS = new Set(["本町", "野田", "清水", "吉田", "長田", "山田", "平野", "福島", "今里", "大正", "新町", "住吉"]);

const KANJI_DIGIT: Record<string, number> ={ 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function kanjiNumber(s: string): number | null {
  if (/^[0-9]+$/.test(s)) return Number(s);
  let total = 0, cur = 0, seen = false;
  for (const ch of s) {
    if (ch in KANJI_DIGIT) { cur = KANJI_DIGIT[ch]; seen = true; }
    else if (ch === "十") { total += (cur || 1) * 10; cur = 0; seen = true; }
    else return null;
  }
  return seen ? total + cur : null;
}

/**
 * 文（desired_area・条件欄・通勤の列）から、電車で行きたい目的地を読む。
 *   「梅田まで電車1本」「梅田に乗り換えなし」「本町直通」→ oneRide
 *   「梅田まで電車で30分」「大阪駅から30分以内」「梅田30分圏内」→ minutes
 *   「北新地へ通勤」「京橋にアクセスがいい」→ 分なし
 * 徒歩・車・バス・自転車の「◯分」は読まない（その駅からの範囲で、電車の通勤ではない）。
 * 目的地は、書かれた語の後ろから一番長い「知っている駅・まとまり」（「勤務先は梅田」→ 梅田）。
 */
export function parseCommuteAsks(text: string | null | undefined, groupOf: (w: string) => TransitGroup | null): CommuteAsk[] {
  const t = String(text ?? "").normalize("NFKC");
  if (!t.trim()) return [];
  const out: CommuteAsk[] = [];
  // 目的地は、書かれた語の中で一番後ろに終わる駅名（同じ終わりなら長い方）。「勤務先は梅田」→ 梅田・「会社が淀屋橋にあり」→ 淀屋橋。
  //   後ろに 市・区・府・町 が続く駅名（「大阪市内」の大阪・「天王寺区」の天王寺）は駅にしない
  const resolve = (w: string): { key: string; word: string } | null => {
    const s = w.replace(/[()（）「」]/g, "").replace(/駅/g, " ");
    for (let j = s.length; j >= 2; j--) {
      for (let i = 0; i <= j - 2; i++) {
        const cand = s.slice(i, j);
        if (/\s/.test(cand)) continue;
        if (/^[市区府町村城]/.test(s.slice(j))) continue;
        // 町名の後ろの2字の駅名（「川俣本町」の本町・「東野田」の野田）は駅にしない（osaka-geo の stationsInText と同じ決まり）
        if (TOWN_SUFFIX_STATIONS.has(cand) && i > 0 && /[一-鿿々]/.test(s[i - 1]) && !/[市区府県線]$/.test(s.slice(0, i)) && !/(?:阪急|阪神|京阪|近鉄|南海|地下鉄|メトロ|JR)$/.test(s.slice(0, i))) continue;
        const g = groupOf(cand);
        if (g) return { key: g.key, word: cand };
      }
    }
    return null;
  };
  const push = (a: CommuteAsk) => {
    const prev = out.find((o) => o.target === a.target);
    if (!prev) { out.push(a); return; }
    if (a.oneRide) prev.oneRide = true;
    if (a.minutes != null && (prev.minutes == null || a.minutes < prev.minutes)) prev.minutes = a.minutes;
    if (a.index < prev.index) prev.index = a.index;
  };
  const NAME = String.raw`([^\s、,。・/／]{1,14}?)`;
  const ONE = new RegExp(NAME + String.raw`駅?(?:まで|から|へ|に)?(?:電車|地下鉄|JR)?で?(?:[1１一]本|(?:乗り?換え?|のりかえ)(?:なし|無し|不要|ゼロ|0回)|直通)`, "g");
  const MIN = new RegExp(NAME + String.raw`駅?(?:まで|から|へ|に)?(?:は)?(?:(電車|地下鉄|JR|徒歩|歩いて|車|バス|自転車|チャリ)で?)?(?:約|およそ)?([0-9]+|[一二三四五六七八九十]+)分(?:以内|圏内|くらい|程度|ほど|まで)?`, "g");
  const SOFT = new RegExp(NAME + String.raw`駅?(?:\([^)]{1,8}\))?(?:まで|へ|に|の)?(?:の)?(?:通勤|通学|アクセス|行きやすい|出やすい)`, "g");
  for (const m of t.matchAll(ONE)) {
    const r = resolve(m[1]);
    if (r) push({ target: r.key, word: r.word, oneRide: true, minutes: null, source: m[0], index: m.index ?? 0 });
  }
  for (const m of t.matchAll(MIN)) {
    if (m[2] && !/^(?:電車|地下鉄|JR)$/.test(m[2])) continue;
    const n = kanjiNumber(m[3]);
    if (n == null || n <= 0 || n > 120) continue;
    const r = resolve(m[1]);
    if (r) push({ target: r.key, word: r.word, oneRide: false, minutes: n, source: m[0], index: m.index ?? 0 });
  }
  for (const m of t.matchAll(SOFT)) {
    const r = resolve(m[1]);
    if (r) push({ target: r.key, word: r.word, oneRide: false, minutes: null, source: m[0], index: m.index ?? 0 });
  }
  return out.sort((a, b) => a.index - b.index);
}
