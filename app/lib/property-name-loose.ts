// app/lib/property-name-loose.ts — ブレインの物件名と、スタッフ・台帳・候補の物件名が「同じ物件か」を、書き方の違いを吸収して比べる（純関数・画面とサーバで共用）
//
// 2026-10-13 竹内さん「AIX の物件名でブレインとスタッフの名前が一致したのが54%。原因を見つけて改善する」→ 外れ70件のうち 24件は同じ物件の書き方違い
//   （号室の形「1-C／103」「3-C」「B-102」「00101」・「2階8号室／8号室」「15番館1303」・WEST／ウエスト・富士／冨士・誤字1〜2字・ブレインが2件を並べた名前）。
//   ここは「ブレインの判断と別の名前を比べる」所だけで使う（customer-state の台帳のお部屋の寄せ方＝matchRoomRefs は変えない＝台帳の部屋を誤って1つにしない）。
// 誤って別の物件に合わせない線（テスト: app/lib/__tests__/property-name-loose.test.ts）:
//   ・号室が両方にあって違えば別の部屋（同じ建物の別の部屋）
//   ・建物名の「区別の印」（数字・ローマ数字 I/II・方角 EAST/WEST/東西南北）が違えば別の建物（「TWIN-I／TWIN II」「難波WEST／難波EAST」「西梅田／東梅田」）
//   ・書き方の違いを許すのは、区別の印が同じで、短い方が5字以上の時だけ（編集距離: 8字以上 2・5〜7字 1）
// 戻す: PROPERTY_NAME_LOOSE_MATCH=off（従来の照合だけ）
import { normalizePropertyName } from "./property-name-match";
import { canonicalRoomLabel } from "./room-no";

/**
 * 既定の env は名前を名指しで読む（画面＝"use client" では process.env を丸ごと渡しても NEXT_PUBLIC_ が入らない。
 *   process.env.NEXT_PUBLIC_… をそのまま書くとビルド時に埋まる・2026-10-13 レビュー）
 */
export function looseMatchEnvFromProcess(): Record<string, string | undefined> {
  return { PROPERTY_NAME_LOOSE_MATCH: process.env.PROPERTY_NAME_LOOSE_MATCH, NEXT_PUBLIC_PROPERTY_NAME_LOOSE_MATCH: process.env.NEXT_PUBLIC_PROPERTY_NAME_LOOSE_MATCH };
}
export function looseMatchEnabled(env: Record<string, string | undefined> = looseMatchEnvFromProcess()): boolean {
  const v = env.PROPERTY_NAME_LOOSE_MATCH ?? env.NEXT_PUBLIC_PROPERTY_NAME_LOOSE_MATCH ?? "";
  return v.toLowerCase() !== "off";
}

export type LooseRef = {
  /** 比べる用の建物の鍵 */
  key: string;
  /** 区別の印（数字・ローマ数字・方角） */
  marks: string;
  /** 号室（先頭の0を外す・英字は大文字。「3-C」は "3C"） */
  room: string | null;
  /** 階（「7階」「2階8号室」の 2・「3-C」の 3） */
  floor: string | null;
};

/** 英字と片仮名の読み替え（物件名によく出る語だけ）。比べる前に片仮名にそろえる */
const WORD_MAP: Array<[RegExp, string]> = [
  [/west|ウェスト/gi, "ウエスト"], [/east/gi, "イースト"], [/north/gi, "ノース"], [/south/gi, "サウス"],
  [/residence/gi, "レジデンス"], [/court/gi, "コート"], [/tower/gi, "タワー"], [/park/gi, "パーク"], [/maison/gi, "メゾン"],
  [/city/gi, "シティ"], [/grand(?!e)/gi, "グラン"], [/premium/gi, "プレミアム"], [/place/gi, "プレイス"], [/front/gi, "フロント"],
  [/阿倍野/g, "あべの"],
];
/** 旧字・異体字 */
const CHAR_MAP: Array<[RegExp, string]> = [[/冨/g, "富"], [/ヴァ/g, "バ"], [/ヴィ/g, "ビ"], [/ヴェ/g, "ベ"], [/ヴォ/g, "ボ"], [/ヴ/g, "ブ"], [/ヶ/g, "ケ"], [/髙/g, "高"], [/﨑/g, "崎"]];
const ROMAN_RE = /(?<![A-Za-z])(?:IV|IX|V?I{1,3}|V|X)(?![A-Za-z])/g;
const DIR_RE = /ウエスト|イースト|ノース|サウス|[東西南北]/g;

const voicing = (s: string) => s.normalize("NFD").replace(/[゙゚]/g, "").normalize("NFC");

function stripHead(t: string): string {
  return t.replace(/^[🌟★☆\s]+/u, "").replace(/^(?:【\s*\d{1,2}\s*】|[①-⑳]|\d{1,2}\s*[.．)）])\s*/, "").replace(/^【\s*|\s*】$/g, "").trim();
}
const room0 = (r: string) => r.replace(/^0+(?=\d)/, "").toUpperCase();

/** 物件名を建物と部屋に分ける（号室の形を広く読む）。物件名でなければ null */
export function parseLoose(raw: string | null | undefined): LooseRef | null {
  // 2026-10-14 号室の読み取りの化け（1O1号室→101号室）をそろえてから読む（room-no.ts・先頭の0は下の room0 が外す）
  let t = canonicalRoomLabel(stripHead(String(raw ?? "").normalize("NFKC").replace(/\s+/g, " ").trim()));
  if (!t) return null;
  t = t.replace(/\s*(?:号室|号)\s*$/, "").replace(/\s*(?:部分|角部屋|の?お部屋)$/, "").trim();
  let building = t, room: string | null = null, floor: string | null = null;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(.*?)\s*(\d{1,2})\s*階\s*(\d{1,3})$/))) { building = m[1]; floor = m[2]; room = room0(m[3]); }            // 2階8号室
  else if ((m = t.match(/^(.*?)\s*(\d{1,2})\s*[-‐－]\s*([A-Za-z])$/))) { building = m[1]; floor = m[2]; room = `${m[2]}${m[3].toUpperCase()}`; } // 3-C
  else if ((m = t.match(/^(.*\S)\s+[A-Za-z]?[-‐－]?(\d{1,5})$/))) { building = m[1]; room = room0(m[2]); }                       // 〇〇 B-102・〇〇 00101・〇〇 302
  else if ((m = t.match(/^(.*\D)(\d{3,4})$/))) { building = m[1]; room = room0(m[2]); }                                            // 15番館1303・ポーラーベアー302
  else if ((m = t.match(/^(.*?)\s*(\d{1,2})\s*階.*$/))) { building = m[1]; floor = m[2]; }                                         // 7階・11階角部屋
  building = building.replace(/[\s・,，、]+$/, "").trim();
  if (room && !floor && room.length >= 3 && /^\d+$/.test(room)) floor = room.slice(0, room.length - 2);
  let b = building;
  for (const [re, to] of WORD_MAP) b = b.replace(re, to);
  for (const [re, to] of CHAR_MAP) b = b.replace(re, to);
  const marks = [
    ...(b.match(/\d+/g) ?? []).map((d) => String(Number(d))),
    ...(b.match(ROMAN_RE) ?? []).map((r) => r.toUpperCase()),
    ...(b.match(DIR_RE) ?? []),
  ].sort().join(",");
  const key = voicing(normalizePropertyName(b)).replace(/[&＆'’.．~〜]/g, "");
  if (key.length < 2) return null;
  return { key, marks, room, floor };
}

function editDistance(a: string, b: string, cap: number): number {
  const x = Array.from(a), y = Array.from(b);
  if (Math.abs(x.length - y.length) > cap) return cap + 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

/** 建物が同じか（書き方の違いを許す・区別の印が違えば別） */
const KANJI_RE = /[一-龯々]/;
/** 片方にだけある漢字の数（多い方）。地名だけ違う同じシリーズの建物（エステムコート梅田／難波）を見分ける */
function kanjiDiff(a: string, b: string): number {
  const count = (s: string) => { const m = new Map<string, number>(); for (const c of Array.from(s)) if (KANJI_RE.test(c)) m.set(c, (m.get(c) ?? 0) + 1); return m; };
  const x = count(a), y = count(b);
  const only = (p: Map<string, number>, q: Map<string, number>) => { let n = 0; for (const [c, k] of p) n += Math.max(0, k - (q.get(c) ?? 0)); return n; };
  return Math.max(only(x, y), only(y, x));
}
/**
 * 建物が同じか（書き方の違いを許す・区別の印が違えば別）。
 * 2026-10-13 レビュー: 同じシリーズで地名だけ違う建物（エステムコート梅田／難波・セレニテ谷町／本町・スプランディッド堀江／難波）を同じと見ていた
 *   （設計知見 abce93ff「似ている・略称は寄せずに未確認」）→ 漢字の書き換えは号室まで同じ時（sameRoom）だけ（読み取りの取り違え「西橘田／西梅田 603」）。
 *   「含む」の枝は足りない字に漢字があれば別（プレサンス大阪／新大阪・天満／天満橋・大阪／大阪城）
 */
export function sameBuildingLoose(a: LooseRef, b: LooseRef, opts: { sameRoom?: boolean } = {}): boolean {
  if (a.key === b.key) return true;
  if (a.marks !== b.marks) return false;
  const short = Math.min(Array.from(a.key).length, Array.from(b.key).length);
  if (short < 6) return false;
  const cap = short >= 8 ? 2 : 1;
  if (editDistance(a.key, b.key, cap) <= cap && (opts.sameRoom || kanjiDiff(a.key, b.key) === 0)) return true;
  // 片方がもう片方を含み、差が2字以内・足りない字に漢字が無い（「コンフォリアリブ博労町一丁目／…一丁目Q」）
  const [s, l] = a.key.length <= b.key.length ? [a.key, b.key] : [b.key, a.key];
  if (!(short >= 6 && l.includes(s) && Array.from(l).length - Array.from(s).length <= 2)) return false;
  return !KANJI_RE.test(l.replace(s, ""));
}

export type LooseMatch = "same_room" | "same_building" | "different_room" | "different";
/** 2つの物件名が同じ物件か（号室が両方にあって違えば different_room・階だけなら建物で見る） */
export function matchLoose(a: string | null | undefined, b: string | null | undefined): LooseMatch {
  const x = parseLoose(a), y = parseLoose(b);
  if (!x || !y || !sameBuildingLoose(x, y, { sameRoom: !!x.room && x.room === y.room })) return "different";
  if (x.room && y.room) {
    if (x.room === y.room) return "same_room";
    // 「1-C」と「103」のように片方が階＋英字の時は、部屋の番号の対応が分からない → 階が同じなら建物で見る
    const letter = (r: string) => /^\d+[A-Z]$/.test(r);
    if ((letter(x.room) !== letter(y.room)) && x.floor && x.floor === y.floor) return "same_building";
    return "different_room";
  }
  // 片方が階だけ・もう片方が号室: 階が違えば別の部屋
  if (x.floor && y.floor && x.floor !== y.floor) return "different_room";
  return "same_building";
}
export const isSameLoose = (m: LooseMatch) => m === "same_room" || m === "same_building";

/**
 * ブレインの名前（「A・B」「A、B」の並びもある）と、名前の並びのどれかが同じ物件か。
 *   まず名前の全体で比べ、合わなければ「、」「・」で分けた各部分（4字以上）で比べる（建物名の中の「・」＝「コンフォリア・リヴ」は全体で合う）
 */
export function brainNameMatchesAny(brainName: string | null | undefined, names: ReadonlyArray<string | null | undefined>): boolean {
  const whole = String(brainName ?? "").trim();
  if (!whole) return false;
  const byComma = whole.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
  const byDot = byComma.flatMap((s) => s.split("・").map((x) => x.trim()));
  const parts = [...new Set([whole, ...byComma, ...byDot])].filter((s) => s === whole || Array.from(s).length >= 4);
  return parts.some((p) => names.some((n) => isSameLoose(matchLoose(p, n))));
}
/** ブレインの名前を物件ごとに分ける（「A・B」「A、B」）。分けた片方が物件名に見えない時は全体のまま */
export function splitBrainNames(brainName: string | null | undefined): string[] {
  const whole = String(brainName ?? "").trim();
  if (!whole) return [];
  const parts = whole.split(/[、,，／/]/).map((s) => s.trim()).filter(Boolean);
  const byComma = parts.length > 1 && parts.every((p) => (parseLoose(p)?.key.length ?? 0) >= 4) ? parts : [whole];
  // 「・」は建物名の中にもある（コンフォリア・リヴ）→ 分けた全部に号室か階がある時だけ物件の並びと読む（「ミラージュパレス本町Depart1302・スプランディッド本町グラン1003」）
  return byComma.flatMap((p) => {
    const ds = p.split("・").map((s) => s.trim()).filter(Boolean);
    return ds.length > 1 && ds.every((d) => { const r = parseLoose(d); return !!r && r.key.length >= 4 && (!!r.room || !!r.floor); }) ? ds : [p];
  });
}
