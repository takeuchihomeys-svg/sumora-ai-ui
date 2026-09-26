// app/lib/search-override-read.ts
// AIXツールのメモ欄の検索の指示の「読み」（サーバー用・osaka-geo の駅・区・路線の表を使う）。形と画面の1行は search-override.ts。
// 2026-09-27 竹内「こちらからの文を DeepSeek の物件検索 AI が要約して、拡張ツールに渡す形」
import { stationsInText, wardsInText, linesInText, normStation, normWard, isKnownStation } from "./osaka-geo";
import { looksLikeSearchInstruction, normText, isEmptyOverride, OVERRIDE_SITES, type OverrideSite, type SearchOverride, type RegisteredConditions, type OverrideSummary } from "./search-override";

// ─────────────────────────── 3. 文の中の根拠 ───────────────────────────

const LAYOUT_TOKEN_RE = /([1-9])\s*(SLDK|SDK|LDK|DK|SK|K|R|L)(?![A-Za-z])/gi;
const LAYOUT_RANK = ["1R", "1K", "1DK", "1LDK", "1SLDK", "2K", "2DK", "2LDK", "2SLDK", "3K", "3DK", "3LDK", "3SLDK", "4K", "4DK", "4LDK", "5K", "5DK", "5LDK"];

function normLayout(n: string, kind: string): string {
  const k = kind.toUpperCase();
  return `${n}${k === "L" ? "LDK" : k}`;
}

/** 文の中の間取り（「1LDK」「1L」「ワンルーム」→ 1R） */
export function layoutsInText(text: string): string[] {
  const t = String(text ?? "").normalize("NFKC");
  const out: string[] = [];
  for (const m of t.matchAll(LAYOUT_TOKEN_RE)) {
    const v = normLayout(m[1], m[2]);
    if (!out.includes(v)) out.push(v);
  }
  if (/ワンルーム/.test(t) && !out.includes("1R")) out.push("1R");
  return out;
}

/** 間取りの形（拡張の page-script が読む形）: 1LDK／1LDK以上／1K〜1LDK／1K・1LDK */
export const FLOOR_PLAN_RE = /^(?:[1-9](?:R|K|DK|LDK|SK|SDK|SLDK))(?:以上|〜[1-9](?:R|K|DK|LDK|SK|SDK|SLDK)|(?:・[1-9](?:R|K|DK|LDK|SK|SDK|SLDK)){0,5})?$/;

/** 文の中の金額（万円の値の集まり）。「8万」「8.5万」「8万5千」「85000円」「8万円」 */
export function moneyInText(text: string): number[] {
  const t = String(text ?? "").normalize("NFKC").replace(/,/g, "");
  const out = new Set<number>();
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*万(?:\s*(\d)\s*千)?/g)) {
    const v = Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0);
    if (Number.isFinite(v)) out.add(Math.round(v * 10) / 10);
  }
  // 「5千円」（万の後ろの千は上で読んでいる）
  for (const m of t.matchAll(/(?<![万\d.])(\d)\s*千/g)) out.add(Number(m[1]) / 10);
  for (const m of t.matchAll(/(\d{4,6})\s*円/g)) {
    const v = Number(m[1]) / 10000;
    if (Number.isFinite(v)) out.add(Math.round(v * 10) / 10);
  }
  return [...out];
}

function numbersNear(text: string, re: RegExp): number[] {
  const t = String(text ?? "").normalize("NFKC");
  const out = new Set<number>();
  for (const m of t.matchAll(re)) { const v = Number(m[1]); if (Number.isFinite(v)) out.add(v); }
  return [...out];
}
// 「◯分以内」だけの書き方は、徒歩の話で電車・通勤の話でない時だけ（「市内に電車で30分以内」を徒歩にしない）
const walkInText = (t: string) => numbersNear(t, /(?:徒歩|歩いて|駅から|駅)\s*(\d{1,2})\s*分/g)
  .concat(/徒歩|歩/.test(t) && !/電車|通勤|乗車|乗って|圏内/.test(t) ? numbersNear(t, /(\d{1,2})\s*分\s*(?:以内|まで|以下)/g) : []);

/** 「2LDK〜」「2LDKから」の後ろに間取りが続かない＝その間取り以上 */
function openEndedLayout(text: string, layout: string): boolean {
  const t = String(text ?? "").normalize("NFKC");
  for (const m of t.matchAll(LAYOUT_TOKEN_RE)) {
    if (normLayout(m[1], m[2]) !== layout) continue;
    const rest = t.slice((m.index ?? 0) + m[0].length);
    if (/^\s*(?:[〜~～]|から)/.test(rest) && !/^\s*(?:[〜~～]|から)\s*[1-9]/.test(rest)) return true;
  }
  return false;
}
const ageInText = (t: string) => numbersNear(t, /築\s*(\d{1,2})\s*年?/g).concat(numbersNear(t, /(\d{1,2})\s*年\s*(?:以内|まで)/g));
const areaInText = (t: string) => numbersNear(t, /(\d{1,3})\s*(?:㎡|平米|m2|m²|平方)/g);

export function siteInText(text: string): OverrideSite | null {
  const t = String(text ?? "").normalize("NFKC").toLowerCase();
  const hits: OverrideSite[] = [];
  if (/(リアプロ|レアプロ|りあぷろ|realnet|realpro|リアルネット)/.test(t)) hits.push("realnetpro");
  if (/(itandi|イタンジ|いたんじ|イタンディ)/.test(t)) hits.push("itandi");
  if (/(レインズ|れいんず|reins)/.test(t)) hits.push("reins");
  return hits.length === 1 ? hits[0] : null;
}

/** 検索全体の広げて／ピンポイントの根拠（1つの条件にかかる「広げて」かどうかは DeepSeek が決める） */
function scopeWordsInText(text: string): { wide: boolean; pinpoint: boolean } {
  const t = normText(text);
  return { wide: /(広げ|広く|広め|ワイド)/.test(t), pinpoint: /(ピンポイント|絞って|絞る|絞り)/.test(t) };
}

const ADD_RE = /(も(?:追加|足|入れ|含め|加え|検索|探|で)|を?追加|足して|加えて|含めて)/;
const EXCLUDE_RE = /(以外|を?外して|抜いて|除いて|除外)/;

// ─────────────────────────── 4. 決定論の読み（DeepSeek が読めない時の代わり） ───────────────────────────

/** 決定論で読む（DeepSeek の答えと同じ形）。検索の指示でなければ is_search=false */
export function parseDeterministic(memo: string, reg?: RegisteredConditions | null): Record<string, unknown> {
  const t = String(memo ?? "").normalize("NFKC");
  const isSearch = looksLikeSearchInstruction(t);
  const unclear: string[] = [];
  const lineHits = linesInText(t);
  const lineSpans = lineHits.map((l) => [l.index, l.index + l.word.length] as const);
  const stations = stationsInText(t).filter((s) => !lineSpans.some(([a, b]) => s.index >= a && s.index < b)).map((s) => s.word.replace(/駅$/, ""));
  const areas = wardsInText(t).map((w) => w.ward);
  const lines = lineHits.map((l) => l.word);
  let location: Record<string, unknown> | null = null;
  if (stations.length || lines.length || areas.length) {
    if (EXCLUDE_RE.test(t)) unclear.push("除外（〇〇以外）の指示は一時調整に入れられません");
    else if (/まで(?:一本|1本|\d+分|電車)/.test(t)) unclear.push("通勤の目的地は検索の駅にしていません");
    else location = { mode: ADD_RE.test(t) ? "add" : "only", stations, lines, areas };
  }
  const layouts = layoutsInText(t);
  let floor_plan: string | null = null;
  if (layouts.length) {
    if (layouts.length === 1 && /以上/.test(t)) floor_plan = `${layouts[0]}以上`;
    else if (layouts.length === 2 && /[〜~～]|から/.test(t)) floor_plan = `${layouts[0]}〜${layouts[1]}`;
    else floor_plan = layouts.join("・");
  }
  const money = [...t.normalize("NFKC").replace(/,/g, "").matchAll(/(\d+(?:\.\d+)?)\s*万(?:\s*(\d)\s*千)?\s*円?\s*(まで|以内|以下|上限|以上|から|〜|~)?/g)];
  let rent_max_man: number | null = null, rent_min_man: number | null = null;
  // 「家賃を1万上げて」「5千円下げて」＝登録の上限からの差分（登録が無ければ読まない）
  const rel = t.match(/(\d+(?:\.\d+)?)\s*(万|千)\s*円?\s*(上げ|アップ|プラス|増や|下げ|ダウン|マイナス|減ら)/);
  if (rel) {
    const d = Number(rel[1]) * (rel[2] === "千" ? 0.1 : 1) * (/^(?:下げ|ダウン|マイナス|減ら)/.test(rel[3]) ? -1 : 1);
    const base = Number(reg?.rent_max);
    if (Number.isFinite(base) && base > 0) rent_max_man = Math.round((base / 10000 + d) * 10) / 10;
    else unclear.push("家賃の差分（登録の上限が無いので読めません）");
    money.length = 0;
  }
  for (const m of money) {
    const v = Math.round((Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0)) * 10) / 10;
    if (/以上|から|〜|~/.test(m[3] ?? "") && money.length > 1) rent_min_man = v;
    else if (/以上/.test(m[3] ?? "")) rent_min_man = v;
    else rent_max_man = v;
  }
  const walk = walkInText(t)[0] ?? null;
  const age = ageInText(t)[0] ?? null;
  const area = numbersNear(t, /(\d{1,3})\s*(?:㎡|平米|m2|m²|平方)\s*(?:以上|から)?/g)[0] ?? null;
  const sc = scopeWordsInText(t);
  // 「家賃8万まで広げて」のように1つの条件にかかる「広げて」は scope にしない（数字の直後の広げ）
  const wideOnCondition = /(万|分|年|㎡|平米|LDK|DK|K)(?:まで|以内|以上)?(?:で|に)?広げ/.test(t);
  return {
    is_search: isSearch,
    location,
    floor_plan,
    rent_max_man, rent_min_man,
    walk_minutes: walk, building_age: age, area_min: area, area_max: null,
    pet: /ペット(?:可|相談|OK|ok)/.test(t) ? true : null,
    site: siteInText(t),
    scope: sc.pinpoint ? "pinpoint" : sc.wide && !wideOnCondition ? "wide" : null,
    unclear,
  };
}

// ─────────────────────────── 5. 文に書いてある物だけ残す ───────────────────────────

const strArr = (v: unknown, n = 10): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, n) : [];
const numOrNull = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const near = (a: number, b: number) => Math.abs(a - b) < 0.051;

/**
 * DeepSeek（か決定論）の答えから、**文に根拠がある値だけ**を SearchOverride にする。
 *   駅: 文の中の駅（osaka-geo.stationsInText）に当たる物だけ。路線の名前の中の駅（「阪急京都線」の京都）は駅にしない
 *   区・市: 文の中の区・市（wardsInText）・路線: 文の中の路線の言い方（linesInText の word）
 *   間取り: 文の中の間取りだけで組み直す・金額/分/年/㎡: 文の中の数字（家賃は「登録の上限±文の数字」も可＝「1万上げて」）
 *   サイト・広げて/ピンポイント: 文にその語がある時だけ
 */
export function validateOverride(raw: Record<string, unknown> | null, memo: string, reg?: RegisteredConditions | null): OverrideSummary & { ai: boolean } {
  const unclear = strArr(raw?.unclear, 5).map((s) => s.slice(0, 60));
  const dropped: string[] = [];
  if (!raw || raw.is_search !== true) return { is_search: false, override: null, unclear: [], dropped, ai: false };
  const t = String(memo ?? "").normalize("NFKC");
  const ov: SearchOverride = { v: 1, location: null, floor_plan: null, rent_max: null, rent_min: null, walk_minutes: null, building_age: null, area_min: null, area_max: null, pet: null, site: null, is_wide: null };

  // 場所
  const loc = (raw.location && typeof raw.location === "object") ? raw.location as Record<string, unknown> : null;
  if (loc) {
    const lineHits = linesInText(t);
    const lineSpans = lineHits.map((l) => [l.index, l.index + l.word.length] as const);
    const stHits = stationsInText(t).filter((s) => !lineSpans.some(([a, b]) => s.index >= a && s.index < b));
    const stByNorm = new Map(stHits.map((s) => [s.station, s.word.replace(/駅$/, "")]));
    const stations: string[] = [];
    for (const s of strArr(loc.stations)) {
      const n = normStation(s);
      const w = stByNorm.get(n);
      if (w && !stations.includes(w)) stations.push(w);
      else if (!w) dropped.push(`駅「${s}」（駅の表に無い）`);
    }
    const wardHits = new Set(wardsInText(t).map((w) => w.ward));
    const areas: string[] = [];
    for (const a of strArr(loc.areas)) {
      const n = normWard(a);
      if (n && wardHits.has(n)) { if (!areas.includes(n)) areas.push(n); continue; }
      // 「茨木」「天王寺」「阿倍野」のように区・市を付けずに書いた駅と同じ名前は、文の中で駅として読んだ物なら駅にする
      //   （2026-09-27 本番の条件の文で DeepSeek が地域に入れて落ちていた）
      const w = stByNorm.get(normStation(a));
      if (w) { if (!stations.includes(w)) stations.push(w); continue; }
      dropped.push(`地域「${a}」（地域の表に無い）`);
    }
    const lines: string[] = [];
    for (const l of strArr(loc.lines)) {
      const nl = String(l).normalize("NFKC");
      const hit = lineHits.find((h) => h.word === nl || nl.includes(h.word) || h.word.includes(nl));
      if (hit) { if (!lines.includes(hit.word)) lines.push(hit.word); }
      else dropped.push(`路線「${l}」（文に無い）`);
    }
    if (stations.length || lines.length || areas.length) {
      const mode = loc.mode === "add" && ADD_RE.test(t) ? "add" : "only";
      if (loc.mode === "add" && mode === "only") dropped.push("追加（文に「も・追加」が無いので『だけ』で読む）");
      ov.location = { mode, stations, lines, areas };
    }
  }

  // 間取り
  if (typeof raw.floor_plan === "string" && raw.floor_plan.trim()) {
    const inText = layoutsInText(t);
    const want = layoutsInText(raw.floor_plan).filter((l) => inText.includes(l));
    const lost = layoutsInText(raw.floor_plan).filter((l) => !inText.includes(l));
    if (lost.length) dropped.push(`間取り「${lost.join("・")}」（文に無い）`);
    if (want.length) {
      const fp = String(raw.floor_plan).normalize("NFKC");
      let v: string;
      // 「2LDK〜」「2LDKから」（後ろに間取りが続かない）＝以上
      const openEnded = want.length === 1 && openEndedLayout(t, want[0]);
      if (want.length === 1 && ((/以上/.test(fp) && /以上/.test(t)) || openEnded)) v = `${want[0]}以上`;
      else if (want.length === 2 && /[〜~～]|から/.test(fp)) {
        const [a, b] = [...want].sort((x, y) => LAYOUT_RANK.indexOf(x) - LAYOUT_RANK.indexOf(y));
        v = `${a}〜${b}`;
      } else v = want.slice(0, 6).join("・");
      if (FLOOR_PLAN_RE.test(v)) ov.floor_plan = v; else dropped.push(`間取り「${fp}」（形が違う）`);
    }
  }

  // 家賃（万円 → 円）。根拠: 文の金額／登録の上限・下限 ± 文の金額（「1万上げて」）
  const money = moneyInText(t);
  const rentOk = (v: number, base: number | null | undefined): boolean => {
    if (money.some((m) => near(m, v))) return true;
    const b = numOrNull(base);
    if (b != null) { const bm = b / 10000; return money.some((m) => near(bm + m, v) || near(bm - m, v)); }
    return false;
  };
  for (const [key, out, base] of [["rent_max_man", "rent_max", reg?.rent_max], ["rent_min_man", "rent_min", reg?.rent_min ?? reg?.rent_max]] as const) {
    const v = numOrNull(raw[key]);
    if (v == null) continue;
    if (v < 1 || v > 50) { dropped.push(`家賃 ${v}万（範囲外）`); continue; }
    if (!rentOk(v, base)) { dropped.push(`家賃 ${v}万（文に無い数字）`); continue; }
    ov[out] = Math.round(v * 10000);
  }
  if (ov.rent_max != null && ov.rent_min != null && ov.rent_min >= ov.rent_max) { dropped.push("家賃の下限が上限以上"); ov.rent_min = null; }

  const pick = (key: string, allowed: number[], lo: number, hi: number, label: string): number | null => {
    const v = numOrNull(raw[key]);
    if (v == null) return null;
    if (v < lo || v > hi) { dropped.push(`${label} ${v}（範囲外）`); return null; }
    if (!allowed.includes(v)) { dropped.push(`${label} ${v}（文に無い数字）`); return null; }
    return v;
  };
  ov.walk_minutes = pick("walk_minutes", walkInText(t), 1, 30, "徒歩");
  ov.building_age = pick("building_age", ageInText(t), 1, 60, "築年数");
  ov.area_min = pick("area_min", areaInText(t), 10, 200, "面積の下限");
  ov.area_max = pick("area_max", areaInText(t), 10, 200, "面積の上限");
  if (ov.area_min != null && ov.area_max != null && ov.area_min >= ov.area_max) { dropped.push("面積の下限が上限以上"); ov.area_min = null; }

  if (raw.pet === true) {
    if (/ペット|犬|猫/.test(t) && !/ペット(?:不可|なし|無し|いらない|不要)/.test(t)) ov.pet = true; else dropped.push("ペット（文に無い）");
  }
  if (typeof raw.site === "string" && raw.site) {
    const s = siteInText(t);
    if (s && s === raw.site) ov.site = s; else dropped.push(`サイト「${raw.site}」（文に無い）`);
  }
  if (raw.scope === "wide" || raw.scope === "pinpoint") {
    const sc = scopeWordsInText(t);
    if (raw.scope === "wide" && sc.wide) ov.is_wide = true;
    else if (raw.scope === "pinpoint" && sc.pinpoint) ov.is_wide = false;
    else dropped.push(`範囲「${raw.scope}」（文に無い）`);
  }
  return { is_search: true, override: ov, unclear, dropped, ai: false };
}


// ─────────────────────────── 7. 積む前の関所（trigger） ───────────────────────────

const SAFE_NAME_RE = /^[^<>{}"'`\\\n\r\t]{1,24}$/;

/**
 * /api/automation/trigger が payload.search_override に入れる前に通す（知らない欄は捨てる・範囲外は null・知らない駅/区は捨てる）。
 * 上書きが1つも無ければ null（＝ふつうの web_brain と同じ）。site / is_wide はコマンドの側（sites・payload.is_wide）で持つので、ここでは写すだけ
 */
export function sanitizeSearchOverride(x: unknown): SearchOverride | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const ov: SearchOverride = { v: 1, location: null, floor_plan: null, rent_max: null, rent_min: null, walk_minutes: null, building_age: null, area_min: null, area_max: null, pet: null, site: null, is_wide: null };
  const loc = o.location && typeof o.location === "object" ? o.location as Record<string, unknown> : null;
  if (loc) {
    const stations = strArr(loc.stations, 10).filter((s) => SAFE_NAME_RE.test(s) && isKnownStation(s));
    const lines = strArr(loc.lines, 5).filter((s) => SAFE_NAME_RE.test(s) && linesInText(s).length > 0);
    const areas = strArr(loc.areas, 10).map((a) => (SAFE_NAME_RE.test(a) ? normWard(a) : null)).filter((a): a is string => !!a);
    if (stations.length || lines.length || areas.length) ov.location = { mode: loc.mode === "add" ? "add" : "only", stations: [...new Set(stations)], lines: [...new Set(lines)], areas: [...new Set(areas)] };
  }
  if (typeof o.floor_plan === "string" && FLOOR_PLAN_RE.test(o.floor_plan.normalize("NFKC"))) ov.floor_plan = o.floor_plan.normalize("NFKC");
  const inRange = (v: unknown, lo: number, hi: number): number | null => { const n = numOrNull(v); return n != null && n >= lo && n <= hi ? n : null; };
  ov.rent_max = inRange(o.rent_max, 10_000, 500_000);
  ov.rent_min = inRange(o.rent_min, 10_000, 500_000);
  if (ov.rent_max != null && ov.rent_min != null && ov.rent_min >= ov.rent_max) ov.rent_min = null;
  ov.walk_minutes = inRange(o.walk_minutes, 1, 30);
  ov.building_age = inRange(o.building_age, 1, 60);
  ov.area_min = inRange(o.area_min, 10, 200);
  ov.area_max = inRange(o.area_max, 10, 200);
  if (ov.area_min != null && ov.area_max != null && ov.area_min >= ov.area_max) ov.area_min = null;
  ov.pet = o.pet === true ? true : null;
  ov.site = typeof o.site === "string" && (OVERRIDE_SITES as readonly string[]).includes(o.site) ? o.site as OverrideSite : null;
  ov.is_wide = typeof o.is_wide === "boolean" ? o.is_wide : null;
  return isEmptyOverride(ov) ? null : ov;
}
