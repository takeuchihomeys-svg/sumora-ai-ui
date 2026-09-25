// app/lib/area-want.ts（純関数・DB 依存なし。サーバーの判定で使う＝画面から import しない・osaka-geo の表が大きいので）
// お客様の「エリア」「通勤」の希望を読み、物件の場所（資料の交通・所在地）と照らす。
//
// 2026-09-25 竹内「エリアの部分、把握できれば理想。地図の配置図、大阪の理解ができていたら理想」
//   「通勤の部分も沿線の知識。拡張ツールの物件検索のデータベースにあるから、それ使えるなら使う」
//
// ■ 読む物（決定論・LLM は使わない）
//   エリア: desired_area（「塚本駅・梅田駅・生野区」「御堂筋線のあびこ駅、西田辺」「大阪市内（環状線エリア）」「北摂」
//     「新大阪〜大国町」「本町から4キロ圏内」「堺筋本町駅から車で15分圏内」「西中島南方じゃなくても可」）と、
//     条件欄の自由文の「◯◯以外」「◯◯は避けたい」「◯◯より北」。
//   通勤: commute_station・commute_minutes（列）と、desired_area・条件欄の「梅田まで電車30分」「大阪駅まで30分圏内」
//     「北加賀屋駅まで45分以内」「梅田(大阪)へ通勤しやすい」「北新地にアクセスがいい」。
//   読めない語（「治安が悪くなく帰る手段が多い地域」）は unread に残し、売上サポの「照らせない条件」に出す。
//
// ■ 照らし方（点は property-brain の REASON_POINTS。外す候補にはしない・読めない時は 0点の要確認）
//   エリア（上から先に当たった物1つ）:
//     以外に当たる → AREA_EXCLUDED（−10・保留）
//     希望の駅そのもの → AREA_STATION_MATCH（+10）／希望の区・市の中 → AREA_WARD_MATCH（+8）／希望の路線の駅 → AREA_LINE_MATCH（+6）／
//     希望の駅・地名から 2km 以内（「付近」「圏内」はその半径）→ AREA_NEAR（+5）／大阪市内・環状線内・北摂の中 → AREA_REGION_MATCH（+3）／
//     4km 以内か隣の区 → AREA_CLOSE（+2）／それより遠い → AREA_FAR（−3・情報の札。検索を広げたのは意図なので保留にしない）
//     物件の場所が読めない → AREA_UNKNOWN（0・要確認）
//     「◯◯より北」に反する → AREA_DIRECTION_NG（−3・情報）
//   通勤（希望が複数なら一番良い物）: 物件の最寄り駅（徒歩の短い順に3つまで）から目的の駅までの最短の乗り方（transit-route）＋徒歩で、
//     希望の分以内 → COMMUTE_OK（+8）／1.2倍か +5分まで → COMMUTE_SLIGHTLY_OVER（0）／超える → COMMUTE_OVER（−5・情報・保留にしない）／
//     分の指定が無い → COMMUTE_INFO（0・所要を見せるだけ）／駅が読めない・路線図に無い → COMMUTE_UNKNOWN（0・要確認）
import {
  normStation, stationPoint, wardPoint, normWard, distanceKm, wardsAdjacent, insideLoop, MULTI_WARD_MAP,
  stationsInText, wardsInText, linesInText, placesInText, townsInText, wardOfStation, wardOfAddress, STATION_LINES, LINES, STATION_GROUPS, isKnownStation, type LatLon,
} from "./osaka-geo";
import { shortestRoute, shortLineName } from "./transit-route";
import { normalizeListingText, parseListingText, parseAccessLine } from "./listing-text";

// ───────────────────────── 型 ─────────────────────────

export type AreaWant = {
  /** 希望の駅（radiusKm＝「付近・圏内」の半径。無ければ既定の 2km） */
  stations: Array<{ station: string; word: string; radiusKm: number | null }>;
  /** 希望の区・市（正式な形） */
  wards: string[];
  /** 希望の路線（「御堂筋線」「阪急沿線」） */
  lines: Array<{ word: string; lines: string[] }>;
  /** 地名（ミナミ・堀江…） */
  places: Array<{ name: string; point: LatLon; radiusKm: number }>;
  /** 広い範囲（大阪市内・環状線の内側・北摂 等） */
  regions: Array<{ kind: "osaka_city" | "loop" | "multi"; name: string; wards?: string[] }>;
  /** 以外・避けたい */
  exclude: { stations: string[]; wards: string[] };
  /** 「◯◯より北」 */
  /** dir＝希望する側（「難波より南は避けたい」は north に反転して持つ）。label＝画面・札に出す元の言い方 */
  directions: Array<{ anchor: string; point: LatLon; dir: "north" | "south" | "east" | "west"; label?: string }>;
  /** 読めなかった語（照らせない条件に出す） */
  unread: string[];
  /** 何か読めたか */
  any: boolean;
  raw: string;
};

export type CommuteWant = { target: string; minutes: number | null; word: string; source: "column" | "area" | "text" };

export type PropertyLocation = {
  /** 資料・説明文の交通（徒歩の短い順・知らない駅も持つ） */
  stations: Array<{ station: string; walk: number | null; line: string | null; known: boolean }>;
  /** 区・市と、その出どころ */
  ward: string | null;
  wardSource: "address" | "station" | null;
  /** 物件の位置（一番近い駅＝知っている駅。無ければ区の中心） */
  point: LatLon | null;
  pointSource: "station" | "ward" | null;
};

export type AreaMatch = {
  code: string;
  /** station_wide＝希望の駅から同じ路線で1〜2駅（広げた検索の駅）・ward_wide＝難波・心斎橋の3区 */
  result: "excluded" | "station" | "station_wide" | "ward" | "ward_wide" | "line" | "near" | "region" | "close" | "far" | "unknown";
  /** 比べた相手（「大国町」「浪速区」「御堂筋線」） */
  anchor: string | null;
  km: number | null;
  why: string;
  directionNg?: string | null;
};
export type CommuteMatch = {
  code: string;
  result: "ok" | "slightly_over" | "over" | "info" | "unknown";
  target: string;
  wantMinutes: number | null;
  minutes: number | null;
  from: string | null;
  walk: number | null;
  transfers: number | null;
  lines: string[];
  why: string;
};

// ───────────────────────── 通勤の希望 ─────────────────────────

const toHalf = (s: string) => String(s ?? "").normalize("NFKC");
const NUM = String.raw`(\d{1,3})`;
/** 「梅田まで電車30分」「大阪駅まで30分圏内」「北加賀屋駅まで45分以内」「本町駅から30分圏内」「難波へ乗り換えなし20分」 */
const COMMUTE_RE = new RegExp(String.raw`([^\s、,・/／()（）]{1,12}?)(?:駅)?\s*(?:\([^)]{1,8}\))?\s*(?:まで|へ|に|から)\s*(?:は|も)?\s*(?:電車|JR|地下鉄|メトロ)?\s*(?:で)?\s*(?:乗り?換え?(?:なし|無し|1回)?|1本|直通)?\s*(?:で)?\s*(?:約)?${NUM}\s*分\s*(?:以内|圏内|程度|くらい|ぐらい|位|まで)?`, "g");
/** 「梅田(大阪)へ通勤しやすい」「北新地にアクセスがいい」「京都に行きやすい」（分の指定なし） */
const COMMUTE_SOFT_RE = /([^\s、,・/／()（）]{1,12}?)(?:駅)?\s*(?:\([^)]{1,8}\))?\s*(?:まで|へ|に|の)?\s*(?:の)?\s*(?:通勤|通学|アクセス|行きやすい|出やすい)/g;
/** 車・タクシー・自転車・徒歩（通勤ではなく、その駅からの範囲） */
const VEHICLE_RE = /(?<!電)車|タクシー|自転車|チャリ|バイク|徒歩|歩いて/;

function commuteTarget(word: string): string | null {
  const w = word.replace(/^(?:JR|大阪メトロ|阪急|阪神|京阪|近鉄|南海)/, "").replace(/駅$/, "");
  if (!w) return null;
  const s = normStation(w);
  if (STATION_LINES.has(s)) return s;
  // 「大阪駅・梅田エリア」の「梅田エリア」・「なんば周辺」
  const inner = stationsInText(w);
  return inner.length ? inner[inner.length - 1].station : null;
}

/** 通勤の希望（列・エリアの文・条件欄の文）。同じ目的地は1つにまとめ、分の指定がある方を残す */
export function parseCommuteWants(c: { commute_station?: string | null; commute_minutes?: number | null; desired_area?: string | null; preferences?: string | null; other_requests?: string | null; additional_conditions?: string | null }): CommuteWant[] {
  const out: CommuteWant[] = [];
  const push = (w: CommuteWant) => {
    const prev = out.find((o) => o.target === w.target);
    if (prev) { if (prev.minutes == null && w.minutes != null) { prev.minutes = w.minutes; prev.word = w.word; } return; }
    out.push(w);
  };
  // 列: 「難波駅・梅田駅」「淀川区（柴島駅、新大阪駅、三国駅）、天六駅」→ 駅ごと
  const col = toHalf(String(c.commute_station ?? ""));
  if (col.trim()) {
    const mins = typeof c.commute_minutes === "number" && c.commute_minutes > 0 ? c.commute_minutes : null;
    const hits = stationsInText(col);
    for (const h of hits) push({ target: h.station, minutes: mins, word: col.slice(0, 30), source: "column" });
  }
  for (const [src, raw] of [["area", c.desired_area], ["text", [c.preferences, c.other_requests, c.additional_conditions].filter(Boolean).join("\n")]] as Array<[CommuteWant["source"], string | null | undefined]>) {
    const t = toHalf(String(raw ?? ""));
    if (!t.trim()) continue;
    for (const m of t.matchAll(COMMUTE_RE)) {
      const whole = m[0];
      if (VEHICLE_RE.test(whole)) continue;
      const target = commuteTarget(m[1]);
      const mins = parseInt(m[2], 10);
      if (!target || !(mins > 0 && mins <= 120)) continue;
      push({ target, minutes: mins, word: whole.trim(), source: src });
    }
    for (const m of t.matchAll(COMMUTE_SOFT_RE)) {
      // 「梅田か難波にアクセス良い」の「梅田か」も目的地（前に並べた駅）
      const before = t.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0).match(/([^\s、,・/／()（）]{1,8}?)(?:駅)?\s*(?:か|や|or|または|もしくは)\s*$/);
      const prev = before ? commuteTarget(before[1]) : null;
      if (prev) push({ target: prev, minutes: null, word: m[0].trim(), source: src });
      for (const part of m[1].split(/(?<=駅)と|か|や|または|もしくは/)) {
        const target = part.trim() ? commuteTarget(part.trim()) : null;
        if (target) push({ target, minutes: null, word: m[0].trim(), source: src });
      }
    }
  }
  return out;
}

// ───────────────────────── エリアの希望 ─────────────────────────

const NEAR_WORD_RE = /^(?:駅)?\s*(?:の)?\s*(?:周辺|付近|近辺|あたり|辺り|ら辺|らへん|寄り|近く|界隈|方面|方|側|エリア)/;
/** 「以外」「NG」「避けたい」。「以外も検討可能」「以外でもOK」は除外ではない（実例: 「鶴見区以外も検討可能」） */
const EXCLUDE_AFTER_RE = /^(?:駅)?\s*(?:は|が)?\s*(?:以外(?!\s*(?:も|でも|の(?:エリア|地域)?も))|NG|ng|不可|避けたい|避け|嫌|いや|除く|なし(?!で))/;
const NOT_REQUIRED_RE = /^(?:駅)?\s*(?:じゃ|で)?なくても(?:可|OK|良い|いい|大丈夫)/;
const DIR_RE = /^(?:駅)?\s*より\s*(北|南|東|西)/;
/** 「より南は避けたい」「より南はNG」＝その向きを避ける（2026-09-25 YUMA: 「難波より南は避けたい」を南の希望と読み、新大阪の物件に「南の希望に反する」を付けていた） */
const DIR_AVOID_RE = /^\s*(?:側|方|方面|の(?:エリア|方|地域|方面))?\s*(?:は|が)?\s*(?:避け|NG|ng|嫌|いや|無理|不可|以外|ダメ|だめ|除く|なし(?!で))/;
const DIR_WORD = { 北: "north", 南: "south", 東: "east", 西: "west" } as const;
const DIR_FLIP = { north: "south", south: "north", east: "west", west: "east" } as const;
/** 駅の後ろの文から向きの希望を読む（避ける言い方なら反対の向きを希望として持つ） */
function directionAfter(anchor: string, after: string): AreaWant["directions"][number] | null {
  const m = after.match(DIR_RE);
  if (!m) return null;
  const p = stationPoint(anchor);
  if (!p) return null;
  const d = DIR_WORD[m[1] as keyof typeof DIR_WORD];
  const avoid = DIR_AVOID_RE.test(after.slice((m.index ?? 0) + m[0].length));
  return { anchor, point: p, dir: avoid ? DIR_FLIP[d] : d, label: `${anchor}より${m[1]}${avoid ? "は避けたい" : ""}` };
}
/** 「本町から4キロ圏内」「堺筋本町駅から車で15分圏内」「◯◯から自転車で10分」→ その駅からの半径（km） */
function radiusAfter(after: string): number | null {
  const km = after.match(/^(?:駅)?\s*から\s*(\d{1,2}(?:\.\d)?)\s*(?:キロ|km|KM|㎞)/);
  if (km) return Math.min(15, parseFloat(km[1]));
  const v = after.match(/^(?:駅)?\s*(?:から|まで)\s*(車|タクシー|自転車|チャリ|バイク|徒歩|歩いて)\s*(?:で)?\s*(\d{1,2})\s*分/);
  if (v) {
    const mins = parseInt(v[2], 10);
    const perMin = /車|タクシー|バイク/.test(v[1]) ? 0.4 : /自転車|チャリ/.test(v[1]) ? 0.25 : 0.08;
    return Math.min(15, Math.max(0.5, +(mins * perMin).toFixed(1)));
  }
  return null;
}

/** 希望のエリアを読む（desired_area＋条件欄の「以外・より北」） */
export function parseAreaWant(desiredArea: string | null | undefined, freeText?: string | null): AreaWant {
  const raw = toHalf(String(desiredArea ?? "")).trim();
  const out: AreaWant = { stations: [], wards: [], lines: [], places: [], regions: [], exclude: { stations: [], wards: [] }, directions: [], unread: [], any: false, raw };
  // 通勤の言い方（「梅田まで電車30分」）はエリアの駅にしない
  const commuteSpans: Array<[number, number]> = [];
  for (const m of raw.matchAll(COMMUTE_RE)) if (!VEHICLE_RE.test(m[0])) commuteSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  for (const m of raw.matchAll(COMMUTE_SOFT_RE)) commuteSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const inCommute = (i: number) => commuteSpans.some(([a, b]) => i >= a && i < b);
  const covered: Array<[number, number]> = [...commuteSpans];

  if (/(?<![東北南西])大阪市内|(?<![東北南西])大阪市(?![^\s、,・]{0,3}区)/.test(raw) && !/大阪市内以外/.test(raw)) out.regions.push({ kind: "osaka_city", name: "大阪市内" });
  if (/環状線(?:内|の内側|エリア|圏内)/.test(raw)) out.regions.push({ kind: "loop", name: "環状線の内側" });
  for (const [name, wards] of Object.entries(MULTI_WARD_MAP)) {
    if (name === "大阪市内") continue;
    if (raw.includes(name)) out.regions.push({ kind: "multi", name, wards });
  }
  for (const r of raw.matchAll(/大阪市内|環状線(?:内|の内側|エリア|圏内)?|北摂|河内|泉州|南河内/g)) covered.push([r.index ?? 0, (r.index ?? 0) + r[0].length]);

  // 住所の書き方（「大阪市淀川区木川西3丁目811」「天王寺南3-8-32」）の区切りは区・市だけ読む（町名の中の「川西」「天王寺」を駅にしない）
  for (const piece of raw.split(/[、,，・/／\n]/)) {
    if (!/[0-9]+\s*丁目|[0-9]+-[0-9]+|番地/.test(piece)) continue;
    const i = raw.indexOf(piece);
    const w = wardOfAddress(piece);
    if (w && !out.wards.includes(w)) out.wards.push(w);
    covered.push([i, i + piece.length]);
  }
  // 町名（拡張の NEIGHBORHOOD_WARD_MAP・「稲田本町」「喜連西」）→ 区・市。駅と同じ名前の町（玉出・長居・千林…）は駅として読む
  const rawStations = stationsInText(raw);
  for (const t of townsInText(raw)) {
    if (covered.some(([a, b]) => t.index < b && t.index + t.word.length > a)) continue;
    // 駅名の中の町名（「今福鶴見」の今福・「諏訪ノ森」の諏訪）は駅として読む（町名の方が長い「稲田本町」は町名）
    if (rawStations.some((s) => s.index <= t.index && s.index + s.word.length >= t.index + t.word.length && s.word.length > t.word.length)) continue;
    if (!out.wards.includes(t.ward)) out.wards.push(t.ward);
    covered.push([t.index, t.index + t.word.length]);
  }
  // 区・市（駅の名前と重なる時は駅を優先したいので、先に駅の位置を取る）
  // 2026-09-25 竹内「沿線指定あれば沿線もちゃんと理解しているのか」: 路線名の中の駅名（「阪急京都線」の京都・「京阪中之島線」の中之島・「阪急宝塚線」の宝塚）を
  //   駅の希望にしない。「線」で終わる路線の言い方が駅名を丸ごと含む時は路線を優先（「野田阪神」のように駅名の方が長い物は駅のまま）
  const lineWordSpans = linesInText(raw).filter((l) => /線|沿い/.test(l.word)).map((l) => [l.index, l.index + l.word.length] as [number, number]);
  const insideLineWord = (s: { index: number; word: string }) => lineWordSpans.some(([a, b]) => s.index >= a && s.index + s.word.length <= b && b - a > s.word.length);
  const st = stationsInText(raw).filter((s) => !inCommute(s.index) && !covered.some(([a, b]) => s.index >= a && s.index < b) && !insideLineWord(s));
  const stSpans = st.map((s) => [s.index, s.index + s.word.length] as [number, number]);
  for (const w of wardsInText(raw)) {
    if (inCommute(w.index)) continue;
    if (covered.some(([a, b]) => w.index >= a && w.index < b)) continue;
    // 「神戸三宮」の「神戸」のように駅名の中の市の名前（「市」「区」が付いていない物）は駅として読む
    if (!/[市区]$/.test(w.word) && stSpans.some(([a, b]) => w.index >= a && w.index < b)) continue;
    const j = w.index + w.word.length;
    // 駅名の中の区・市（「茨木市」駅と「茨木市」）は市として読む（駅も同じ所）
    const after = raw.slice(j, j + 8);
    if (EXCLUDE_AFTER_RE.test(after)) { if (!out.exclude.wards.includes(w.ward)) out.exclude.wards.push(w.ward); covered.push([w.index, j]); continue; }
    if (!out.wards.includes(w.ward)) out.wards.push(w.ward);
    covered.push([w.index, j]);
  }
  for (const s of st) {
    const j = s.index + s.word.length;
    // 市の名前と同じ駅（茨木市・枚方市…）で市として読めた物は駅にしない
    if (covered.some(([a, b]) => s.index >= a && j <= b)) continue;
    const after = raw.slice(j, j + 16);
    covered.push([s.index, j]);
    if (EXCLUDE_AFTER_RE.test(after)) { if (!out.exclude.stations.includes(s.station)) out.exclude.stations.push(s.station); continue; }
    if (DIR_RE.test(after)) {
      const d = directionAfter(s.station, after);
      if (d) out.directions.push(d);
      continue;
    }
    // 「西中島南方じゃなくても可」は希望の駅だが必須ではない（駅としては残す）
    void NOT_REQUIRED_RE;
    const r = radiusAfter(after);
    const near = NEAR_WORD_RE.test(after);
    if (!out.stations.some((x) => x.station === s.station)) out.stations.push({ station: s.station, word: s.word, radiusKm: r ?? (near ? 2.0 : null) });
  }
  for (const l of linesInText(raw)) {
    if (inCommute(l.index)) continue;
    // 駅名の中の会社名（「野田阪神」の阪神）は路線にしない・同じ言い方は1つ
    if (stSpans.some(([a, b]) => l.index >= a && l.index < b)) continue;
    if (out.lines.some((x) => x.word === l.word)) continue;
    // 「環状線エリア」は範囲（上で読んだ）。「御堂筋線のあびこ駅」は駅の説明だが、路線の希望としても持つ（同じ線なら合う）
    if (/環状線/.test(l.word) && out.regions.some((r) => r.kind === "loop")) continue;
    out.lines.push({ word: l.word, lines: l.lines });
    covered.push([l.index, l.index + l.word.length]);
  }
  // 「新大阪〜大国町」「野江～放出」: 同じ路線の2駅の間の駅も希望に入れる（間の駅が「希望の駅」になる）
  for (const m of raw.matchAll(/([^\s、,・/／()（）〜～~]{2,12}?)(?:駅)?\s*[〜～~]\s*([^\s、,・/／()（）]{2,12}?)(?:駅)?(?=[\s、,・/／()（）]|$)/g)) {
    const a = normStation(m[1]), b = normStation(m[2]);
    for (const st2 of Object.values(LINES)) {
      const ia = st2.indexOf(a), ib = st2.indexOf(b);
      if (ia < 0 || ib < 0) continue;
      const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia];
      if (hi - lo > 25) continue;
      for (const x of st2.slice(lo, hi + 1)) if (!out.stations.some((y) => y.station === x)) out.stations.push({ station: x, word: `${m[1]}〜${m[2]}`, radiusKm: null });
      break;
    }
  }
  for (const p of placesInText(raw)) { out.places.push({ name: p.name, point: p.point, radiusKm: p.radiusKm }); covered.push([p.index, p.index + p.word.length]); }
  void stSpans;

  // 読めなかった語（区切りで割って、何にも当たらない物）
  const pieces = raw.split(/[、,，・/／\n。]|\s+|または|もしくは/).map((x) => x.trim()).filter((x) => x.length >= 2);
  for (const p of pieces) {
    const i = raw.indexOf(p);
    const j = i + p.length;
    const hit = covered.some(([a, b]) => a < j && b > i);
    if (hit) continue;
    if (/^(?:特に(?:決めてません|なし|ない)|なし|どこでも|未定|こだわらない|周辺|付近|あたり|近辺|エリア|駅|大阪府?|大阪市|希望|第[一二三]希望.*)$/.test(p)) continue;
    out.unread.push(p.slice(0, 30));
  }

  // 条件欄の自由文: 「◯◯以外」「◯◯は避けたい」「◯◯より北」だけ（希望の駅・区は desired_area を正にする）
  const ft = toHalf(String(freeText ?? ""));
  if (ft.trim()) {
    for (const s of stationsInText(ft)) {
      const after = ft.slice(s.index + s.word.length, s.index + s.word.length + 12);
      if (EXCLUDE_AFTER_RE.test(after) && !out.exclude.stations.includes(s.station)) out.exclude.stations.push(s.station);
      const d = directionAfter(s.station, after);
      if (d) out.directions.push(d);
    }
    for (const w of wardsInText(ft)) {
      const after = ft.slice(w.index + w.word.length, w.index + w.word.length + 12);
      if (EXCLUDE_AFTER_RE.test(after) && !out.exclude.wards.includes(w.ward)) out.exclude.wards.push(w.ward);
    }
  }
  out.any = !!(out.stations.length || out.wards.length || out.lines.length || out.places.length || out.regions.length || out.exclude.stations.length || out.exclude.wards.length || out.directions.length);
  return out;
}

// ───────────────────────── 物件の場所 ─────────────────────────

/** 説明文と資料の文字層から物件の場所を読む（交通の行・所在地） */
export function buildPropertyLocation(summary: string | null | undefined, pdfText: string | null | undefined): PropertyLocation {
  const stations: PropertyLocation["stations"] = [];
  const push = (station: string | null, walk: number | null, line: string | null) => {
    if (!station) return;
    const s = normStation(station);
    if (!s) return;
    const prev = stations.find((x) => x.station === s);
    if (prev) { if (walk != null && (prev.walk == null || walk < prev.walk)) prev.walk = walk; return; }
    stations.push({ station: s, walk, line, known: isKnownStation(s) });
  };
  const lf = pdfText ? parseListingText(pdfText) : null;
  for (const a of lf?.access ?? []) if (!a.bus) push(a.station, a.walk, a.line);
  // 交通の見出しの形で読めない資料（文字が短い・見出しが無い）は、徒歩のある行を1行ずつ読む
  if (pdfText && !stations.length) {
    for (const l of normalizeListingText(pdfText).split("\n")) {
      if (!/徒歩|停歩/.test(l) || !/駅|「/.test(l)) continue;
      const a = parseAccessLine(l);
      if (a && !a.bus && a.station) push(a.station, a.walk, a.line);
    }
  }
  // 説明文の交通（「恵美須町駅 徒歩5分」「堺筋線「恵美須町」徒歩5分」）
  for (const l of String(summary ?? "").split("\n").slice(1)) {
    if (!/徒歩|駅|「/.test(l) || /^(?:AD|広告)/i.test(l.trim())) continue;
    const a = parseAccessLine(toHalf(l));
    if (a && !a.bus && a.station) push(a.station, a.walk, a.line);
  }
  stations.sort((x, y) => (x.walk ?? 99) - (y.walk ?? 99));
  let ward: string | null = null, wardSource: PropertyLocation["wardSource"] = null;
  if (pdfText) {
    const t = normalizeListingText(pdfText);
    const addr = (t.match(/所在地[ \t]*[:：]?[ \t]*\n?[ \t]*([^\n]+)/) ?? [])[1] ?? null;
    const w = addr ? wardOfAddress(addr) : null;
    if (w) { ward = w; wardSource = "address"; }
  }
  if (!ward) {
    for (const s of stations) { const w = wardOfStation(s.station); if (w) { ward = w; wardSource = "station"; break; } }
  }
  const knownSt = stations.find((s) => s.known && stationPoint(s.station) && !stationPoint(s.station)?.approx);
  let point: LatLon | null = null, pointSource: PropertyLocation["pointSource"] = null;
  if (knownSt) { const p = stationPoint(knownSt.station)!; point = { lat: p.lat, lon: p.lon }; pointSource = "station"; }
  else if (ward) { const p = wardPoint(ward); if (p) { point = p; pointSource = "ward"; } }
  return { stations, ward, wardSource, point, pointSource };
}

// ───────────────────────── 照らす ─────────────────────────

/**
 * 2026-09-25 竹内「広げて検索した場合も、お客さんの希望の駅の方が点数少し大きくするように。隣の駅だからって点数が大幅に低くならないように」
 *   拡張の「広げて検索」は希望の駅ごとに**同じ路線の前後1駅**を足す（resolution-core.js resolveConditionsLocal ④ getAdjacentStations・
 *   popup.js の手動の検索も同じ。同じ事業者の4路線以上の大きな駅だけ手動では足さない）。路線の並びは同じ popup-maps.js の写し（LINES）。
 *   → 希望の駅 +10（AREA_STATION_MATCH）／前後1駅 +8（AREA_STATION_WIDE・広げた検索の駅）／同じ路線で2駅 +6（AREA_STATION_2STOPS）。
 *   今までは隣の駅も距離で見ていたので +5（2km 以内）〜 +2 まで下がっていた。
 *   地域（区）で検索した時は、難波・心斎橋（中央区・浪速区・西区）を3区まとめて足す（popup.js expandNambaCodes）→ AREA_WARD_WIDE +6
 */
export const WIDE_STATION_STOPS = 1;
export const NAMBA_CLUSTER_WARDS = ["大阪市中央区", "大阪市浪速区", "大阪市西区"];

/** 駅のまとまり（STATION_GROUPS）の駅。まとまりに無い駅はその駅だけ */
export function stationGroupOf(station: string): string[] {
  for (const members of Object.values(STATION_GROUPS)) if (members.includes(station)) return members;
  return [station];
}

/** 2駅の間の駅の数（同じ路線に両方ある時の一番少ない数・同じ駅は 0・同じ路線に無ければ null） */
export function stopsBetween(a: string, b: string): { stops: number; line: string } | null {
  if (a === b) return { stops: 0, line: "" };
  let best: { stops: number; line: string } | null = null;
  for (const line of STATION_LINES.get(a) ?? []) {
    const order = LINES[line] ?? [];
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia < 0 || ib < 0) continue;
    let d = Math.abs(ia - ib);
    // 環状線は輪（LINES は輪を閉じない形で 大阪…天満 の両端が隣）。反証レビュー 2026-09-25: 天満の希望で大阪の物件が 18駅離れていた
    if (line === "大阪環状線" && order.length > 2) d = Math.min(d, order.length - d);
    if (!best || d < best.stops) best = { stops: d, line };
  }
  return best;
}

/** 拡張の「広げて検索」が足す駅（同じ路線の前後1駅）。拡張の getAdjacentStations と同じ */
export function adjacentStations(station: string): string[] {
  const out: string[] = [];
  for (const line of STATION_LINES.get(station) ?? []) {
    const order = LINES[line] ?? [];
    const i = order.indexOf(station);
    if (i > 0 && !out.includes(order[i - 1])) out.push(order[i - 1]);
    if (i >= 0 && i < order.length - 1 && !out.includes(order[i + 1])) out.push(order[i + 1]);
  }
  return out;
}

export const AREA_NEAR_KM = 2.0;
/** 希望の駅そのもの（AREA_STATION_MATCH）とみなす徒歩の上限 */
export const STATION_MATCH_WALK_MAX = 15;
export const AREA_CLOSE_KM = 4.0;

const km1 = (v: number) => Math.round(v * 10) / 10;
const shortWard = (w: string) => w.replace(/^大阪市/, "");

/** エリアの照合（希望が何も読めない時は null＝札なし） */
export function matchArea(want: AreaWant, loc: PropertyLocation): AreaMatch | null {
  if (!want.any) return null;
  const stNames = loc.stations.map((s) => s.station);
  // 以外
  const exSt = stNames.find((s) => want.exclude.stations.includes(s));
  if (exSt) return { code: "AREA_EXCLUDED", result: "excluded", anchor: exSt, km: null, why: `${exSt}は希望外（以外）` };
  if (loc.ward && want.exclude.wards.includes(loc.ward)) return { code: "AREA_EXCLUDED", result: "excluded", anchor: loc.ward, km: null, why: `${shortWard(loc.ward)}は希望外（以外）` };
  const hasPositive = want.stations.length || want.wards.length || want.lines.length || want.places.length || want.regions.length;
  let dirNg: string | null = null;
  if (loc.point) {
    for (const d of want.directions) {
      const dLat = loc.point.lat - d.point.lat, dLon = loc.point.lon - d.point.lon;
      const ng = (d.dir === "north" && dLat < -0.004) || (d.dir === "south" && dLat > 0.004) || (d.dir === "east" && dLon < -0.005) || (d.dir === "west" && dLon > 0.005);
      if (ng) { dirNg = d.label && /避けたい$/.test(d.label) ? `${d.label}に当たる` : `${d.anchor}より${({ north: "北", south: "南", east: "東", west: "西" } as const)[d.dir]}の希望に反する`; break; }
    }
  }
  const withDir = (m: AreaMatch): AreaMatch => (dirNg ? { ...m, directionNg: dirNg } : m);
  if (!hasPositive) {
    if (dirNg) return { code: "AREA_DIRECTION_NG", result: "far", anchor: null, km: null, why: dirNg };
    return null;
  }
  if (!loc.point && !loc.ward && !stNames.length) return { code: "AREA_UNKNOWN", result: "unknown", anchor: null, km: null, why: "物件の場所が資料から読めない" };
  // 希望の駅そのもの
  // 徒歩 15分を超える駅は「その駅の物件」とは言えない（資料の3行目の遠い駅）→ 距離で見る
  const walkable = loc.stations.filter((x) => x.walk == null || x.walk <= STATION_MATCH_WALK_MAX).map((x) => x.station);
  // 駅のまとまり（STATION_GROUPS: 梅田＝梅田・大阪・西梅田・北新地、天王寺＝天王寺・大阪阿部野橋 等）は同じ駅として見る。
  //   反証レビュー 2026-09-25: 梅田の希望で JR大阪駅の物件が AREA_NEAR +5、隣の中津が AREA_STATION_WIDE +8 と、広げた駅の方が高くなっていた
  const hitSt = walkable.find((s) => want.stations.some((w) => stationGroupOf(w.station).includes(s)));
  if (hitSt) return withDir({ code: "AREA_STATION_MATCH", result: "station", anchor: hitSt, km: 0, why: `希望の駅（${hitSt}）` });
  // 希望の駅から同じ路線で1駅（拡張の広げて検索の駅）・2駅。物件の駅（徒歩15分以内）と希望の駅（まとまりの駅も）の組で一番近い物
  let stopHit: { st: string; want: string; stops: number; line: string } | null = null;
  for (const s of walkable) for (const w of want.stations) for (const m of stationGroupOf(w.station)) {
    const b = stopsBetween(s, m);
    if (b && b.stops >= 1 && b.stops <= 2 && (!stopHit || b.stops < stopHit.stops)) stopHit = { st: s, want: w.station, stops: b.stops, line: b.line };
  }
  const lineShort = (l: string) => shortLineName(l);
  if (stopHit && stopHit.stops <= WIDE_STATION_STOPS) {
    return withDir({ code: "AREA_STATION_WIDE", result: "station_wide", anchor: stopHit.want, km: null, why: `広げた検索の駅（${stopHit.st}＝希望の${stopHit.want}の隣・${lineShort(stopHit.line)}）` });
  }
  // 希望の区・市（大阪市内の広い言い方は下の region）
  if (loc.ward && want.wards.includes(loc.ward)) return withDir({ code: "AREA_WARD_MATCH", result: "ward", anchor: loc.ward, km: null, why: `希望の${/区$/.test(loc.ward) ? "区" : "市"}（${shortWard(loc.ward)}）` });
  if (stopHit) return withDir({ code: "AREA_STATION_2STOPS", result: "station_wide", anchor: stopHit.want, km: null, why: `希望の${stopHit.want}から${lineShort(stopHit.line)}で2駅（${stopHit.st}）` });
  // 難波・心斎橋の3区（拡張が地域の広げて検索でまとめて足す）
  if (loc.ward && NAMBA_CLUSTER_WARDS.includes(loc.ward) && want.wards.some((w) => NAMBA_CLUSTER_WARDS.includes(w))) {
    const w0 = want.wards.find((w) => NAMBA_CLUSTER_WARDS.includes(w)) as string;
    return withDir({ code: "AREA_WARD_WIDE", result: "ward_wide", anchor: loc.ward, km: null, why: `広げた検索の区（${shortWard(loc.ward)}＝希望の${shortWard(w0)}と同じ難波・心斎橋の3区）` });
  }
  // 希望の路線の駅
  for (const s of loc.stations) {
    const ls = STATION_LINES.get(s.station) ?? [];
    const hit = want.lines.find((w) => w.lines.some((l) => ls.includes(l)));
    if (hit) return withDir({ code: "AREA_LINE_MATCH", result: "line", anchor: hit.word, km: null, why: `希望の路線（${hit.word}・${s.station}）` });
  }
  // 距離（希望の駅・地名・区の中心のうち一番近い物）
  let best: { name: string; km: number; radius: number } | null = null;
  if (loc.point) {
    for (const w of want.stations) {
      const p = stationPoint(w.station);
      if (!p) continue;
      const d = distanceKm(loc.point, p);
      const radius = w.radiusKm ?? AREA_NEAR_KM;
      if (!best || d - radius < best.km - best.radius) best = { name: w.station, km: d, radius };
    }
    for (const pl of want.places) {
      const d = distanceKm(loc.point, pl.point);
      if (!best || d - pl.radiusKm < best.km - best.radius) best = { name: pl.name, km: d, radius: pl.radiusKm };
    }
    for (const w of want.wards) {
      const p = wardPoint(w);
      if (!p) continue;
      // 区の中心から。区の半径は 約1.5km（市は 3km）とみなす
      const d = distanceKm(loc.point, p);
      const radius = /区$/.test(w) ? 1.5 : 3.0;
      if (!best || d - radius < best.km - best.radius) best = { name: shortWard(w), km: d, radius };
    }
  }
  if (best && best.km <= best.radius) return withDir({ code: "AREA_NEAR", result: "near", anchor: best.name, km: km1(best.km), why: `希望の${best.name}から${km1(best.km)}km` });
  // 広い範囲
  for (const r of want.regions) {
    const inRegion = r.kind === "osaka_city" ? !!loc.ward && /^大阪市/.test(loc.ward)
      : r.kind === "loop" ? !!loc.point && loc.pointSource === "station" && insideLoop(loc.point)
      : !!loc.ward && (r.wards ?? []).includes(loc.ward);
    if (inRegion) return withDir({ code: "AREA_REGION_MATCH", result: "region", anchor: r.name, km: null, why: `希望の範囲（${r.name}）` });
  }
  const adjacent = !!loc.ward && want.wards.some((w) => wardsAdjacent(w, loc.ward as string));
  if (best && (best.km <= AREA_CLOSE_KM || adjacent)) return withDir({ code: "AREA_CLOSE", result: "close", anchor: best.name, km: km1(best.km), why: adjacent && best.km > AREA_CLOSE_KM ? `希望の区の隣（${shortWard(loc.ward as string)}）` : `希望の${best.name}から${km1(best.km)}km` });
  if (!best && adjacent) return withDir({ code: "AREA_CLOSE", result: "close", anchor: shortWard(loc.ward as string), km: null, why: `希望の区の隣（${shortWard(loc.ward as string)}）` });
  if (best) return withDir({ code: "AREA_FAR", result: "far", anchor: best.name, km: km1(best.km), why: `希望の${best.name}から${km1(best.km)}km` });
  // 路線・範囲だけの希望で当たらない
  if (want.regions.length || want.lines.length) {
    if (!loc.ward && !loc.point) return { code: "AREA_UNKNOWN", result: "unknown", anchor: null, km: null, why: "物件の場所が資料から読めない" };
    return withDir({ code: "AREA_FAR", result: "far", anchor: (want.regions[0]?.name ?? want.lines[0]?.word) ?? null, km: null, why: `希望の${want.regions[0]?.name ?? want.lines[0]?.word}の外` });
  }
  return { code: "AREA_UNKNOWN", result: "unknown", anchor: null, km: null, why: "物件の場所が資料から読めない" };
}

export const COMMUTE_SLIGHT_RATIO = 1.2;
export const COMMUTE_SLIGHT_MIN = 5;

/** 通勤の照合（希望ごと・一番良い物を先頭に） */
export function matchCommute(wants: CommuteWant[], loc: PropertyLocation): CommuteMatch[] {
  const out: CommuteMatch[] = [];
  const cands = loc.stations.filter((s) => s.known).slice(0, 3);
  for (const w of wants) {
    let best: { minutes: number; from: string; walk: number | null; transfers: number; lines: string[] } | null = null;
    for (const s of cands) {
      const r = shortestRoute(s.station, w.target);
      if (!r) continue;
      const total = r.minutes + (s.walk ?? 0);
      if (!best || total < best.minutes) best = { minutes: total, from: s.station, walk: s.walk, transfers: r.transfers, lines: r.lines.map(shortLineName) };
    }
    if (!best) {
      out.push({ code: "COMMUTE_UNKNOWN", result: "unknown", target: w.target, wantMinutes: w.minutes, minutes: null, from: null, walk: null, transfers: null, lines: [], why: `${w.target}までの乗り方が分からない（最寄り駅が読めない）` });
      continue;
    }
    const detail = `${w.target}まで約${best.minutes}分（${best.from}${best.walk != null ? `徒歩${best.walk}分` : ""}・乗換${best.transfers}回）`;
    let result: CommuteMatch["result"];
    if (w.minutes == null) result = "info";
    else if (best.minutes <= w.minutes) result = "ok";
    else if (best.minutes <= Math.max(w.minutes * COMMUTE_SLIGHT_RATIO, w.minutes + COMMUTE_SLIGHT_MIN)) result = "slightly_over";
    else result = "over";
    const code = { ok: "COMMUTE_OK", slightly_over: "COMMUTE_SLIGHTLY_OVER", over: "COMMUTE_OVER", info: "COMMUTE_INFO", unknown: "COMMUTE_UNKNOWN" }[result];
    out.push({ code, result, target: w.target, wantMinutes: w.minutes, minutes: best.minutes, from: best.from, walk: best.walk, transfers: best.transfers, lines: best.lines, why: w.minutes != null ? `${detail}／希望${w.minutes}分` : detail });
  }
  const rank = { ok: 0, slightly_over: 1, info: 2, over: 3, unknown: 4 } as const;
  return out.sort((a, b) => rank[a.result] - rank[b.result]);
}

/** 判定の札（エリア1つ・向き・通勤1つ） */
export function locationReasonCodes(area: AreaMatch | null, commute: CommuteMatch[]): string[] {
  const out: string[] = [];
  if (area) {
    out.push(area.code);
    if (area.directionNg && area.code !== "AREA_DIRECTION_NG") out.push("AREA_DIRECTION_NG");
  }
  if (commute.length) out.push(commute[0].code);
  return out;
}

/** 売上サポに出す1行（「📍 恵美須町 徒歩5分・浪速区｜希望の大国町から0.8km｜梅田まで約15分（乗換1）」） */
export function formatLocationLine(loc: PropertyLocation, area: AreaMatch | null, commute: CommuteMatch[]): string {
  const parts: string[] = [];
  const st = loc.stations[0];
  const head = [st ? `${st.station}${st.walk != null ? ` 徒歩${st.walk}分` : ""}` : null, loc.ward ? shortWard(loc.ward) : null].filter(Boolean).join("・");
  if (head) parts.push(head);
  if (area) parts.push(area.why + (area.directionNg && area.code !== "AREA_DIRECTION_NG" ? `（${area.directionNg}）` : ""));
  for (const c of commute.slice(0, 2)) parts.push(c.why);
  return parts.length ? `📍 ${parts.join("｜")}` : "";
}

/** property_pickups.location に残す形 */
export type PickupLocation = {
  v: 1;
  stations: PropertyLocation["stations"];
  ward: string | null;
  wardSource: PropertyLocation["wardSource"];
  area: AreaMatch | null;
  commute: CommuteMatch[];
  line: string;
};
export function toPickupLocation(loc: PropertyLocation, area: AreaMatch | null, commute: CommuteMatch[]): PickupLocation {
  return { v: 1, stations: loc.stations.slice(0, 4), ward: loc.ward, wardSource: loc.wardSource, area, commute: commute.slice(0, 3), line: formatLocationLine(loc, area, commute) };
}

/** 画面の「照らせない条件」に出すエリアの読めない語 */
export function areaUnreadLabel(w: AreaWant): string[] {
  return w.unread.map((u) => `エリア: ${u}`);
}

export { normWard };
