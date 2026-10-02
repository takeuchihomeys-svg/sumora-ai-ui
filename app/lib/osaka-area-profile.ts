// app/lib/osaka-area-profile.ts（純関数・静的データ・DB 依存なし。osaka-geo の表が大きいのでサーバーで使う＝画面から import しない）
// 「なんば・梅田に出やすい」「タクシーで帰宅してもそこまでかからない」のような“場所に対する”エリアの希望を、区と駅に直す。
//
// 2026-10-02 竹内「難波や梅田近辺の浪速区や、大正、西区、北区、福島区、中央区等で通いやすい地域を物件検索ブレインは選定する事が出来ているか、
//   大阪の町の関係、場所や家賃の相場把握していれば最善の場所が出るし、お客さんに対しても聞かれたら説明出来るし、検索もしやすい」
//   松浦さん（desired_area「なんば・梅田に出やすいエリア」）: なんば＝住む駅・梅田＝分の無い通勤先（0点）に割れ、梅田側の物件が
//   「希望のなんばから4.9km」AREA_FAR −3。拡張の検索の語も「すい所」「梅田に出」に壊れ、西区・福島区・大正区は検索に入っていなかった。
//
// ■ 竹内さんの決定（2026-10-02・RELATIVE_AREA_RULE の1か所）
//   ①「〇〇に出やすい」で分の指定が無い時は「電車15分以内・乗り換えなし」（十三→梅田 約3分 も入る）
//   ②「タクシーでそこまでかからない」は基準の地点から直線で約5km以内。お客様に円は言わない
//   ③ 淀川区（十三・西中島南方）は「梅田に出やすい」に入る（①の線で自然に入る）
//   ⑤ 区の特徴の文はまだ決めていない → WARD_NOTES は空のまま（竹内さんが書く欄）
//
// ■ 静的と動的の分け方（メモリ feedback_static_vs_dynamic_db）
//   静的（このファイル・osaka-geo・transit-route）: 駅・区の位置、路線の並び、到達時間、距離
//   動的（DB rent_observations / area_rent_stats）: 家賃の相場（app/lib/area-rent-explain.ts）
import { normStation, stationPoint, distanceKm, wardOfStation, stationsInText, linesInText, isKnownStation, STATION_GROUPS, STATION_LINES, LINES, type LatLon } from "./osaka-geo";
import { stationsWithin, transit, oneRideStations } from "./transit-route";

/** 竹内さんの決定（2026-10-02）。線を変える時はここだけ */
export const RELATIVE_AREA_RULE = {
  /** 「出やすい」で分の指定が無い時の電車の分（乗っている分＋乗り換え。徒歩は含めない） */
  softMinutes: 15,
  /** 乗り換えの回数（0＝乗り換えなし） */
  softMaxTransfers: 0,
  /** 「タクシーでそこまでかからない」の直線距離（km） */
  taxiKm: 5,
} as const;

/** 区の特徴（竹内さんが書く欄・2026-10-02 は未定のため空）。ここに無い区は特徴を言わない（文を作らない） */
export const WARD_NOTES: Record<string, string> = {};

/** 地名 → 基準の駅（「ミナミ・キタに出やすい」） */
const PLACE_ANCHOR: Record<string, string> = { ミナミ: "なんば", キタ: "梅田" };

/** 「出やすい」系の言い方（分の指定なし） */
const SOFT_WORD_RE = /出やす|行きやす|通いやす|通勤しやす|通学しやす|アクセス\s*(?:が|の|も)?\s*(?:良|いい|よい|しやす|重視|良好|抜群)|便利/g;
/** 前に並ぶ地点の区切り */
const LIST_SEP_RE = /(?:・|、|,|，|\/|／|と|か|や|or|または|もしくは|及び)\s*$/;
/** 地点の後ろの助詞（「梅田駅(大阪)へも」） */
const TAIL_PARTICLE_RE = /(?:駅)?\s*(?:\([^)]{1,8}\)|（[^）]{1,8}）)?\s*(?:に|へ|まで)?\s*(?:の)?\s*(?:も)?\s*$/;
/** 「タクシーで帰宅してもそこまでかからない」「タクシーでも近い」「ワンメーター」（分・km の指定が無い言い方） */
const TAXI_VAGUE_RE = /タクシー[^。\n]{0,24}?(?:かからない|かからん|かからず|近い|近く|ワンメーター|安い|安く|帰れる|帰宅|圏内|距離)/;
/** 「◯◯からタクシーで10分」（分の指定あり＝area-want の radiusAfter が読む） */
const TAXI_MINUTES_RE = /タクシー\s*(?:で|とかで)?\s*[0-9]{1,2}\s*分/;

export type RelativeAnchor = {
  /** 基準の駅（まとまりの代表＝transit の groupOf の key） */
  station: string;
  /** お客様の言い方 */
  word: string;
  /** soft＝「出やすい」（RELATIVE_AREA_RULE）／ride＝「1本・乗り換えなし・直通・乗り継ぎ N 回」（readRideAsks）。無ければ soft */
  kind?: "soft" | "ride";
  /** ride の分（無ければ null＝乗り換えなしで着く沿線ぜんぶ） */
  minutes?: number | null;
  /** ride の乗り換えの回数（0＝なし） */
  maxTransfers?: number;
  /** 「御堂筋線で梅田まで1本」の路線の絞り（osaka-geo の路線名） */
  lines?: string[] | null;
};

export type RelativeAreaWant = {
  anchors: RelativeAnchor[];
  /** 「タクシーでそこまでかからない」の直線距離（km）。無ければ null */
  taxiKm: number | null;
  /** 文の中の「出やすい」の言い方の位置（area-want がエリアの駅にしないため） */
  spans: Array<[number, number]>;
  /** 読んだ元の言い方 */
  words: string[];
  /** 「御堂筋線で1本」のように目的の駅が無く路線だけの「1本」（osaka-geo の路線名）。その路線の駅ぜんぶ */
  rideLines?: string[];
};

const nfkc = (s: string) => String(s ?? "").normalize("NFKC");

/** 地点の名前を基準の駅（まとまりの代表）に */
function anchorStation(word: string): string | null {
  const w = word.replace(/駅$/, "").trim();
  if (!w) return null;
  if (PLACE_ANCHOR[w]) return PLACE_ANCHOR[w];
  const s = normStation(w);
  if (!isKnownStation(s)) return null;
  const g = transit().groupOf(s);
  return g ? g.key : s;
}

/** 文の終わりにある地点の名前（駅・ミナミ／キタ）。無ければ null */
function trailingAnchor(s: string): { station: string; word: string; start: number } | null {
  for (const [p, st] of Object.entries(PLACE_ANCHOR)) if (s.endsWith(p)) return { station: st, word: p, start: s.length - p.length };
  const hits = stationsInText(s);
  const last = hits[hits.length - 1];
  if (!last || last.index + last.word.length !== s.length) return null;
  const station = anchorStation(last.word);
  return station ? { station, word: last.word, start: last.index } : null;
}

/**
 * 「A・Bに出やすい」「梅田か難波にアクセス良い」「大阪駅へのアクセス重視」の地点を読む（分の指定がある言い方は area-want の通勤が読む）。
 * タクシー: 「タクシーで帰宅してもそこまでかからない」＝ RELATIVE_AREA_RULE.taxiKm（分の指定がある「タクシーで10分」は読まない）
 */
export function readRelativeArea(text: string | null | undefined, freeText?: string | null): RelativeAreaWant {
  const t = nfkc(String(text ?? ""));
  const out: RelativeAreaWant = { anchors: [], taxiKm: null, spans: [], words: [] };
  for (const m of t.matchAll(SOFT_WORD_RE)) {
    const k = m.index ?? 0;
    // 同じ句の中に「◯分」がある時は分の指定がある通勤（area-want の COMMUTE_RE）に任せる
    if (/[0-9]{1,3}\s*分/.test(t.slice(Math.max(0, k - 20), k))) continue;
    let s = t.slice(0, k);
    const tail = s.match(TAIL_PARTICLE_RE);
    if (tail) s = s.slice(0, s.length - tail[0].length);
    const found: RelativeAnchor[] = [];
    let start = k;
    for (let guard = 0; guard < 8; guard++) {
      const a = trailingAnchor(s);
      if (!a) break;
      found.unshift({ station: a.station, word: a.word });
      start = a.start;
      s = s.slice(0, a.start);
      const sep = s.match(LIST_SEP_RE);
      if (!sep) break;
      s = s.slice(0, s.length - sep[0].length).replace(/(?:駅)\s*$/, "");
    }
    if (!found.length) continue;
    for (const f of found) if (!out.anchors.some((x) => x.station === f.station)) out.anchors.push(f);
    out.spans.push([start, k + m[0].length]);
    out.words.push(t.slice(start, k + m[0].length));
  }
  const all = `${t}\n${nfkc(String(freeText ?? ""))}`;
  if (TAXI_VAGUE_RE.test(all) && !TAXI_MINUTES_RE.test(all)) out.taxiKm = RELATIVE_AREA_RULE.taxiKm;
  return out;
}

// ───────────────────────── 「1本・乗り換えなし・直通」（2026-10-02 竹内さん） ─────────────────────────
// 竹内「よくある乗り換えなしとかもその沿線全部で調べる形で分数もしていあればその駅を選択できるようにする」
//   ・乗り換えなし（分の指定なし）→ 目的の駅に乗り換えなしで着く沿線（直通の運転も）の駅ぜんぶ（拡張は路線ごとに全駅を選ぶ）
//   ・乗り換えなし＋分 → その沿線のうち N 分以内の駅
//   ・乗り継ぎ N 回＋分 → N 回までで N 分以内の駅（分の無い「乗り換え1回で行ける」は作らない＝線が無いので通勤の列に任せる）
//   ・「御堂筋線で1本」（目的の駅なし）→ その路線の駅ぜんぶ
// 実物（messages.sender=customer・property_customers）: 「梅田、中津まで電車1本で行けるところ…15分から２０分以内くらい」「難波か梅田まで電車一本」
//   「梅田まで1本で行ける線」「難波まで1本10-15分以内」「御堂筋線で1本の場所」「梅田まで30分以内で乗り継ぎ一回」「乗り継ぎ2回以内で梅田まで30分以内」

/** 「1本」「乗り換えなし」「直通」「乗り継ぎ N 回」 */
const RIDE_RE = /(?:[1１一]\s*本|直通|(?:乗り?換え?|乗換え?|のりかえ|乗り継ぎ|乗継ぎ?)\s*(?:なし|無し|不要|ゼロ|せず|しない|[0０]\s*回)|(?:乗り?換え?|乗換え?|のりかえ|乗り継ぎ|乗継ぎ?)\s*([1-3一二三])\s*回)/g;
const KANJI_N: Record<string, number> = { 一: 1, 二: 2, 三: 3 };
/** 分の言い方（「20分以内」「20分くらい」「10-15分以内」「15分から20分以内」）。範囲は上の方 */
const MIN_RE = /(?:約|およそ)?([0-9]{1,3})\s*(?:分\s*)?(?:[-〜~～]|から)\s*([0-9]{1,3})\s*分|(?:約|およそ)?([0-9]{1,3})\s*分\s*(?:以内|圏内|くらい|ぐらい|程度|ほど|位|まで)?/g;
/** 分の前がこれなら電車の分ではない（徒歩・車・自転車・バス・「駅まで15分」） */
const NOT_TRAIN_BEFORE_RE = /(?:徒歩|歩いて|歩き|車で?|自転車で?|チャリで?|バスで?|タクシーで?|(?:^|[^一-龥ァ-ヶぁ-ん])駅(?:まで|から)|駅徒歩)\s*(?:約)?\s*$/;
/** 区切り（フォームの番号・見出し・改行）を越えて分を探さない */
const FIELD_BREAK_RE = /[①-⑳【\n]/;

function rideMinutesNear(t: string, from: number, to: number): number | null {
  // 前は 25字まで・後ろは 40字まで。フォームの区切り（⑥ 等）を越えない
  let a = Math.max(0, from - 25);
  const before = t.slice(a, from);
  const bb = Math.max(before.lastIndexOf("\n"), ...[...before.matchAll(/[①-⑳【]/g)].map((m) => m.index ?? -1));
  if (bb >= 0) a += bb + 1;
  let b = Math.min(t.length, to + 40);
  const after = t.slice(to, b);
  const ab = after.search(FIELD_BREAK_RE);
  if (ab >= 0) b = to + ab;
  const win = t.slice(a, b);
  let best: { v: number; d: number } | null = null;
  for (const m of win.matchAll(MIN_RE)) {
    const i = a + (m.index ?? 0);
    if (NOT_TRAIN_BEFORE_RE.test(t.slice(Math.max(0, i - 6), i))) continue;
    const v = m[2] ? parseInt(m[2], 10) : parseInt(m[3] ?? "", 10);
    if (!(v > 0 && v <= 90)) continue;
    const d = i < from ? from - i : i - to;
    if (!best || d < best.d) best = { v, d };
  }
  return best ? best.v : null;
}

/** 「1本・乗り換えなし・直通・乗り継ぎ N 回」の目的の駅・分・路線を読む */
export function readRideAsks(text: string | null | undefined): RelativeAreaWant {
  const t = nfkc(String(text ?? ""));
  const out: RelativeAreaWant = { anchors: [], taxiKm: null, spans: [], words: [], rideLines: [] };
  for (const m of t.matchAll(RIDE_RE)) {
    const k = m.index ?? 0;
    const end = k + m[0].length;
    const before6 = t.slice(Math.max(0, k - 8), k);
    // 「電話の直通」「直通の固定番号」「1本道」は電車の話ではない
    if (/直通/.test(m[0]) && /^(?:の?固定|の?番号|電話|ダイヤル|TEL)/i.test(t.slice(end, end + 6))) continue;
    if (/本/.test(m[0]) && !/(?:まで|へ|に|で|線|電車|メトロ|地下鉄|JR)\s*$/.test(before6)) continue;
    const transfers = m[1] ? (KANJI_N[m[1]] ?? parseInt(m[1], 10)) : 0;
    // 目的の駅: 前（「梅田まで1本」「難波か梅田まで電車一本」）→ 無ければ後ろ（「乗り継ぎ2回以内で梅田まで」）
    // 「まで」の「で」は落とさない（「梅田まで1本」）
    let s = t.slice(0, k).replace(/(?:(?:電車|地下鉄|メトロ|JR)\s*(?:で)?|(?<!ま)で)\s*$/, "");
    // 「梅田まで30分以内で乗り継ぎ一回」: 間の分の言い方を飛ばして目的の駅を探す（分は rideMinutesNear が読む）
    s = s.replace(/(?:約)?[0-9]{1,3}\s*(?:分\s*)?(?:(?:[-〜~～]|から)\s*[0-9]{1,3}\s*)?分\s*(?:以内|圏内|くらい|ぐらい|程度|ほど|位)?\s*(?:で)?\s*$/, "");
    const part = s.match(/(?:駅)?\s*(?:\([^)]{1,8}\))?\s*(?:まで|へ|に|から)\s*(?:は|も)?\s*$/);
    const found: RelativeAnchor[] = [];
    let start = k;
    let lines: string[] | null = null;
    if (part) {
      s = s.slice(0, s.length - part[0].length);
      for (let guard = 0; guard < 8; guard++) {
        const a = trailingAnchor(s);
        if (!a) break;
        found.unshift({ station: a.station, word: a.word });
        start = a.start;
        s = s.slice(0, a.start);
        const sep = s.match(LIST_SEP_RE);
        if (!sep) break;
        s = s.slice(0, s.length - sep[0].length).replace(/(?:駅)\s*$/, "");
      }
      // 「御堂筋線で梅田まで1本」の路線
      const lm = s.match(/([^\s、。,]{1,12}線)\s*で\s*$/);
      if (found.length && lm) { const l = linesInText(lm[1])[0]; if (l) { lines = l.lines; start = s.length - lm[0].length; } }
    } else {
      // 「御堂筋線で1本」（目的の駅なし）
      const lm = s.match(/([^\s、。,]{1,12}線)\s*(?:で|の)?\s*$/);
      const l = lm ? linesInText(lm[1])[0] : null;
      if (l && transfers === 0) {
        // 路線は area-want の「希望の路線」としても読む（範囲に入れない＝AREA_LINE_MATCH のまま）
        for (const x of l.lines) if (!out.rideLines!.includes(x)) out.rideLines!.push(x);
        out.words.push(t.slice(k - (lm as RegExpMatchArray)[0].length, end));
        continue;
      }
    }
    if (!found.length) {
      const post = t.slice(end, end + 24).match(/^\s*(?:以内|まで)?\s*(?:で|の)?\s*(?:電車で)?\s*([^\s、。,]{1,12}?)(?:駅)?\s*(?:まで|へ|に)/);
      const st = post ? anchorStation(post[1]) : null;
      if (st) found.push({ station: st, word: post![1] });
    }
    if (!found.length) continue;
    const minutes = rideMinutesNear(t, start, end);
    // 「乗り換え1回で行けるところ」（分なし）は線が無い＝作らない（通勤の列・到達時間に任せる）
    if (transfers > 0 && minutes == null) continue;
    for (const f of found) {
      if (out.anchors.some((x) => x.station === f.station)) continue;
      out.anchors.push({ ...f, kind: "ride", minutes, maxTransfers: transfers, lines });
    }
    out.spans.push([start, end]);
    out.words.push(t.slice(start, end));
  }
  return out;
}

// ───────────────────────── 到達（静的な路線図から・決定論） ─────────────────────────

const reachCache = new Map<string, Map<string, number>>();
/** 基準の駅に「電車 N 分以内・乗り換え M 回まで」で着く駅 → 分（まとまりの駅は 0） */
export function reachMap(anchor: string, minutes: number = RELATIVE_AREA_RULE.softMinutes, maxTransfers: number = RELATIVE_AREA_RULE.softMaxTransfers): Map<string, number> {
  const key = `${anchor}|${minutes}|${maxTransfers}`;
  const hit = reachCache.get(key);
  if (hit) return hit;
  const m = new Map<string, number>();
  const g = transit().groupOf(anchor);
  for (const s of g?.members ?? [anchor]) m.set(s, 0);
  const w = stationsWithin(anchor, minutes, { maxTransfers });
  for (const s of w?.stations ?? []) if (!m.has(s.station) || (m.get(s.station) as number) > s.minutes) m.set(s.station, s.minutes);
  reachCache.set(key, m);
  return m;
}

/** 基準の駅（まとまり）の位置の一覧 */
export function anchorPoints(anchor: string): LatLon[] {
  const members = transit().groupOf(anchor)?.members ?? STATION_GROUPS[anchor] ?? [anchor];
  return members.map((s) => stationPoint(s)).filter((p): p is NonNullable<typeof p> => !!p).map((p) => ({ lat: p.lat, lon: p.lon }));
}

/** 位置から基準の駅（まとまりの一番近い駅）までの直線距離 */
export function kmToAnchor(p: LatLon, anchor: string): number | null {
  const pts = anchorPoints(anchor);
  if (!pts.length) return null;
  return Math.min(...pts.map((q) => distanceKm(p, q)));
}

export type AreaPlanStation = { station: string; ward: string | null; reach: Array<{ anchor: string; minutes: number }>; km: number | null };
export type AreaPlanWard = { ward: string; stations: string[]; bestMinutes: number; km: number | null };
export type AreaPlan = {
  v: 1;
  /** soft＝「出やすい」／ride＝「1本・乗り換えなし・直通・乗り継ぎ」 */
  kind: "soft" | "ride";
  /** stations＝駅を1つずつ選ぶ／lines＝路線ごとに全駅を選ぶ（乗り換えなし・分の指定なし・「御堂筋線で1本」） */
  mode: "stations" | "lines";
  anchors: RelativeAnchor[];
  rule: { minutes: number | null; maxTransfers: number; taxiKm: number | null };
  stations: AreaPlanStation[];
  wards: AreaPlanWard[];
  /** mode=lines の路線（osaka-geo の路線名＝リアプロの内部名・拡張に無い名前は extLines で直す） */
  lines: string[];
  /** 画面・ブレインに出す1行（事実だけ。お客様への文ではない） */
  summary: string;
};

/** osaka-geo で足した路線名 → 拡張の辞書の路線名（リアプロ内部名）。commute-reach-core の LINE_TO_EXT と同じ */
export const LINE_TO_EXT: Record<string, string[]> = { "JR神戸線": ["東海道本線"], "JR宝塚線": ["福知山線"], "JRゆめ咲線": ["桜島線"] };
export function extLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) for (const x of LINE_TO_EXT[l] ?? [l]) if (!out.includes(x)) out.push(x);
  return out;
}

/** 駅を1つずつ選ぶ時の上限（commute-reach-core の DEFAULT_MAX_STATIONS と同じ） */
export const AREA_PLAN_MAX_STATIONS = 240;

const r1 = (v: number) => Math.round(v * 10) / 10;
const shortWard = (w: string) => w.replace(/^大阪市/, "");
const onLines = (st: string, lines: string[] | null | undefined) => !lines?.length || (STATION_LINES.get(st) ?? []).some((l) => lines.includes(l));

/** 基準の駅（1つ）に着く駅 → 分。ride で分が無い時は乗り換えなしで着く沿線の駅ぜんぶ（分は表示用・90分まで） */
export function anchorReach(a: RelativeAnchor): { reach: Map<string, number>; lines: string[] } {
  const members = transit().groupOf(a.station)?.members ?? [a.station];
  if (a.kind !== "ride") return { reach: reachMap(a.station), lines: [] };
  if (a.minutes != null) {
    const m = new Map<string, number>();
    for (const [st, v] of reachMap(a.station, a.minutes, a.maxTransfers ?? 0)) if (members.includes(st) || onLines(st, a.lines)) m.set(st, v);
    return { reach: m, lines: [] };
  }
  const one = oneRideStations(a.station);
  const timing = reachMap(a.station, 90, 0);
  const m = new Map<string, number>();
  for (const s of members) m.set(s, 0);
  const lines: string[] = [];
  for (const r of one?.routes ?? []) {
    if (a.lines?.length && !r.lines.some((l) => a.lines!.includes(l))) continue;
    for (const l of r.lines) if (!lines.includes(l)) lines.push(l);
    for (const st of r.stations) if (!m.has(st)) m.set(st, timing.get(st) ?? 99);
  }
  return { reach: m, lines };
}

/**
 * 決定論の検索の範囲（area_plan）。
 *   soft: 基準の駅のどれかに「電車15分以内・乗り換えなし」で着く駅（タクシーの希望がある時は直線 taxiKm 以内だけ）
 *   ride: 乗り換えなし（分なし）＝沿線ぜんぶ（mode=lines）／分あり＝その分の駅（mode=stations）／路線だけ＝その路線の駅ぜんぶ
 * 地点も路線も無い時は null。
 */
export function buildAreaPlan(want: RelativeAreaWant): AreaPlan | null {
  const rideLines = want.rideLines ?? [];
  if (!want.anchors.length && !rideLines.length) return null;
  const ride = want.anchors.some((a) => a.kind === "ride") || rideLines.length > 0;
  const rideAnchors = want.anchors.filter((a) => a.kind === "ride");
  const anchors = ride ? rideAnchors : want.anchors;
  const mode: AreaPlan["mode"] = ride && anchors.every((a) => a.minutes == null) ? "lines" : "stations";
  const first = anchors[0];
  const rule = ride
    ? { minutes: first?.minutes ?? null, maxTransfers: first?.maxTransfers ?? 0, taxiKm: null }
    : { minutes: RELATIVE_AREA_RULE.softMinutes as number, maxTransfers: RELATIVE_AREA_RULE.softMaxTransfers as number, taxiKm: want.taxiKm };
  const byStation = new Map<string, AreaPlanStation>();
  const lines: string[] = [];
  for (const a of anchors) {
    const r = anchorReach(a);
    for (const l of r.lines) if (!lines.includes(l)) lines.push(l);
    for (const [st, min] of r.reach) {
      const cur = byStation.get(st) ?? { station: st, ward: wardOfStation(st), reach: [], km: null };
      if (!cur.reach.some((x) => x.anchor === a.station)) cur.reach.push({ anchor: a.station, minutes: min });
      byStation.set(st, cur);
    }
  }
  for (const l of rideLines) {
    if (!lines.includes(l)) lines.push(l);
    for (const st of LINES[l] ?? []) if (!byStation.has(st)) byStation.set(st, { station: st, ward: wardOfStation(st), reach: [], km: null });
  }
  const stations: AreaPlanStation[] = [];
  for (const s of byStation.values()) {
    const p = stationPoint(s.station);
    const kms = p ? anchors.map((a) => kmToAnchor(p, a.station)).filter((v): v is number => v != null) : [];
    s.km = kms.length ? r1(Math.min(...kms)) : null;
    if (rule.taxiKm != null && (s.km == null || s.km > rule.taxiKm)) continue;
    s.reach.sort((x, y) => x.minutes - y.minutes);
    stations.push(s);
  }
  stations.sort((x, y) => (x.reach[0]?.minutes ?? 99) - (y.reach[0]?.minutes ?? 99) || (x.km ?? 99) - (y.km ?? 99));
  // 駅を1つずつ選ぶ時は上限（通勤の到達時間と同じ 240・リアプロの入力の時間切れ 90秒との兼ね合い）。分の短い順に残す
  const total = stations.length;
  if (mode === "stations" && stations.length > AREA_PLAN_MAX_STATIONS) stations.length = AREA_PLAN_MAX_STATIONS;
  const wardMap = new Map<string, AreaPlanWard>();
  for (const s of stations) {
    if (!s.ward) continue;
    const w = wardMap.get(s.ward) ?? { ward: s.ward, stations: [], bestMinutes: 99, km: null };
    w.stations.push(s.station);
    w.bestMinutes = Math.min(w.bestMinutes, s.reach[0]?.minutes ?? 99);
    if (s.km != null) w.km = w.km == null ? s.km : Math.min(w.km, s.km);
    wardMap.set(s.ward, w);
  }
  const wards = [...wardMap.values()].sort((a, b) => b.stations.length - a.stations.length || a.bestMinutes - b.bestMinutes);
  const names = anchors.map((a) => a.station).join("・");
  const tr = (n: number) => (n === 0 ? "乗り換えなし" : `乗り換え${n}回まで`);
  let head: string;
  if (!ride) head = `${names}に電車${rule.minutes}分以内・${tr(rule.maxTransfers)}で出られる駅 ${stations.length}駅`;
  else if (!anchors.length) head = `${rideLines.join("・")}の駅ぜんぶ ${stations.length}駅（路線ごとに全駅）`;
  else if (mode === "lines") head = `${names}に乗り換えなしで着く沿線ぜんぶ ${lines.length}路線・${stations.length}駅（路線ごとに全駅）`;
  else head = `${names}に電車${rule.minutes}分以内・${tr(rule.maxTransfers)}で着く駅 ${stations.length}駅${total > stations.length ? `（${total}駅を分の短い順に${stations.length}駅まで）` : ""}${first?.lines?.length ? `（${first.lines[0]}）` : ""}`;
  const taxi = rule.taxiKm != null ? `（タクシーの目安: ${names}から直線${rule.taxiKm}km以内）` : "";
  const wardLine = wards.slice(0, 12).map((w) => `${shortWard(w.ward)}${w.stations.length}`).join("・");
  return { v: 1, kind: ride ? "ride" : "soft", mode, anchors, rule, stations, wards, lines, summary: `${head}${taxi}｜${wardLine}` };
}

/** 区の到達の事実（ブレイン・スタッフ向けの材料。お客様への文は area-rent-explain.ts の型だけ） */
export function wardAccessFacts(plan: AreaPlan, max = 8): string[] {
  return plan.wards.slice(0, max).map((w) => {
    const ex = plan.stations.find((s) => s.ward === w.ward);
    const reach = ex?.reach.map((r) => (r.minutes === 0 ? `${r.anchor}の駅` : `${r.anchor}まで約${r.minutes}分`)).join("・") ?? "";
    const note = WARD_NOTES[w.ward] ? `｜${WARD_NOTES[w.ward]}` : "";
    return `${shortWard(w.ward)}: ${w.stations.slice(0, 5).join("・")}${w.stations.length > 5 ? ` ほか${w.stations.length - 5}駅` : ""}（例: ${ex?.station ?? ""}＝${reach}${w.km != null ? `・直線${w.km}km` : ""}）${note}`;
  });
}
