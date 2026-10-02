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
import { normStation, stationPoint, distanceKm, wardOfStation, stationsInText, isKnownStation, STATION_GROUPS, type LatLon } from "./osaka-geo";
import { stationsWithin, transit } from "./transit-route";

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
};

export type RelativeAreaWant = {
  anchors: RelativeAnchor[];
  /** 「タクシーでそこまでかからない」の直線距離（km）。無ければ null */
  taxiKm: number | null;
  /** 文の中の「出やすい」の言い方の位置（area-want がエリアの駅にしないため） */
  spans: Array<[number, number]>;
  /** 読んだ元の言い方 */
  words: string[];
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

// ───────────────────────── 到達（静的な路線図から・決定論） ─────────────────────────

const reachCache = new Map<string, Map<string, number>>();
/** 基準の駅に「電車 N 分以内・乗り換え M 回まで」で着く駅 → 分（まとまりの駅は 0） */
export function reachMap(anchor: string, minutes = RELATIVE_AREA_RULE.softMinutes, maxTransfers = RELATIVE_AREA_RULE.softMaxTransfers): Map<string, number> {
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
  anchors: RelativeAnchor[];
  rule: { minutes: number; maxTransfers: number; taxiKm: number | null };
  stations: AreaPlanStation[];
  wards: AreaPlanWard[];
  /** 画面・ブレインに出す1行（事実だけ。お客様への文ではない） */
  summary: string;
};

const r1 = (v: number) => Math.round(v * 10) / 10;
const shortWard = (w: string) => w.replace(/^大阪市/, "");

/**
 * 決定論の検索の範囲（area_plan）。基準の駅のどれかに「電車15分以内・乗り換えなし」で着く駅。
 * タクシーの希望がある時は、基準の駅のどれかから直線 taxiKm 以内の駅だけ。地点が読めない時は null。
 */
export function buildAreaPlan(want: RelativeAreaWant): AreaPlan | null {
  if (!want.anchors.length) return null;
  const rule = { minutes: RELATIVE_AREA_RULE.softMinutes, maxTransfers: RELATIVE_AREA_RULE.softMaxTransfers, taxiKm: want.taxiKm };
  const byStation = new Map<string, AreaPlanStation>();
  for (const a of want.anchors) {
    for (const [st, min] of reachMap(a.station, rule.minutes, rule.maxTransfers)) {
      const cur = byStation.get(st) ?? { station: st, ward: wardOfStation(st), reach: [], km: null };
      if (!cur.reach.some((r) => r.anchor === a.station)) cur.reach.push({ anchor: a.station, minutes: min });
      byStation.set(st, cur);
    }
  }
  const stations: AreaPlanStation[] = [];
  for (const s of byStation.values()) {
    const p = stationPoint(s.station);
    const kms = p ? want.anchors.map((a) => kmToAnchor(p, a.station)).filter((v): v is number => v != null) : [];
    s.km = kms.length ? r1(Math.min(...kms)) : null;
    if (rule.taxiKm != null && (s.km == null || s.km > rule.taxiKm)) continue;
    s.reach.sort((x, y) => x.minutes - y.minutes);
    stations.push(s);
  }
  stations.sort((x, y) => (x.reach[0]?.minutes ?? 99) - (y.reach[0]?.minutes ?? 99) || (x.km ?? 99) - (y.km ?? 99));
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
  const names = want.anchors.map((a) => a.station).join("・");
  const head = `${names}に電車${rule.minutes}分以内・${rule.maxTransfers === 0 ? "乗り換えなし" : `乗り換え${rule.maxTransfers}回まで`}で出られる駅 ${stations.length}駅`;
  const taxi = rule.taxiKm != null ? `（タクシーの目安: ${names}から直線${rule.taxiKm}km以内）` : "";
  const wardLine = wards.slice(0, 12).map((w) => `${shortWard(w.ward)}${w.stations.length}`).join("・");
  return { v: 1, anchors: want.anchors, rule, stations, wards, summary: `${head}${taxi}｜${wardLine}` };
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
