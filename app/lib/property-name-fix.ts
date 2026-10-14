// app/lib/property-name-fix.ts（純関数・DB 依存なし・サーバー専用＝osaka-geo の表が大きいので画面から import しない）
// 画像から読んだ物件名の「読み取りの化け」を、地名の表・物件名の帳簿・化けの癖の表で直す。直すのは候補が1つに決まる時だけ。
//
// 2026-10-14 竹内さん「物件名はシリーズ名＋地名の形が多い。物件検索のデータ（駅の表・エリアの表・売上サポの物件の行）と読み取りをつなぐ」
//   ①資料の文字の層を正に ②送った本文・売上サポ・AIX の記録・資料から正しい物件名の帳簿（出所と回数つき）
//   ③地名の部分を駅・地名の表と照らし、実在しない地名（梅出・戸原橋・令福・速里）は化けと見て正しい地名に直す
//   ④過去の実例から化けの癖の表（梅出→梅田・戸原橋→芦原橋・令福→今福・速里→遠里・カシーダ→カシータ・ヴィプラス→ヴィブラス）
//   直すのは候補が1つに決まる時だけ（シリーズ違い・地名違いの別の建物に寄せない＝property-name-loose の線と同じ・設計知見 abce93ff）。
//   迷う時は触らず「確かではない」（status="uncertain"）。
//
// 実データ（2026-10-14・scripts/build-property-name-ledger.ts）: 照合できなかった読み取りの名前（source=vision）695種類のうち、
//   帳簿の名前と1〜2字だけ違う物 317。多い化け: 難波→雑賀（13）・雜賀・鶴渡・雑波・離波・雛波・藍渡・滝波・阪波／堺筋→堤筋・磐筋・蜂筋・堀筋・矢筋／
//   芦原橋→戸原橋／今福→令福／遠里小野→速里小野・選里小野・浅里小野／駒川→駹川／ミラージュパレス→ミレージュバレス／スプランディッド→スプランディド。
//
// 決まり（どれも「候補が1つ」の時だけ）:
//   A 帳簿の名前と同じ（建物の鍵が信頼できる帳簿の行にある）→ そのまま（known）
//   B 地名の部分（漢字の並び）が地名の表に無い → 1字違い・旧字・化けの癖の表で表にある地名にできる → その名前が帳簿にあれば直す（fixed）。
//     帳簿に無くても、旧字（大國町→大国町）・化けの癖の表で3回以上見た化け（雑賀→難波）は直す（地名だけの直し）
//   C 地名の部分が表にあり同じ・シリーズ名（片仮名・英字）だけ1〜2字違う帳簿の名前が1つ → 直す（区別の印＝数字・ローマ数字・方角が同じ時だけ）
//   それ以外で地名が表に無い・候補が2つ以上 → uncertain（名前はそのまま）
// 戻す: PROPERTY_NAME_FIX=off
import { parseLoose } from "./property-name-loose";
import { LINES, ALIASES, WARD_COORDS } from "./osaka-geo";
import { EXT_STATION_WARD_MAP, EXT_NEIGHBORHOOD_WARD_MAP } from "./osaka-transit-data";
import { toJapaneseKanji } from "./ja-kanji";
import { CONFUSION_TOKENS, CONFUSION_CHARS, LEARNED_PLACE_TOKENS } from "./property-name-confusions";

export function propertyNameFixEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PROPERTY_NAME_FIX ?? "").trim().toLowerCase() !== "off";
}

// ───────────── 地名の表 ─────────────
/** 地名に付いてよい頭・尻（「新大阪」「南堀江」「谷町四丁目」「〜駅前」） */
const AFFIX = new Set(["東", "西", "南", "北", "新", "元", "上", "下", "中", "本", "駅前", "前", "町", "通", "丁目", "公園", "台", "橋", "筋", "駅"]);
const KANJI_NUM = "一二三四五六七八九十";
/** 地名でない漢字の並び（建物の印・資料の語）。地名の直しの対象にも候補にもしない */
export const NOT_PLACE_RE = /^第|号室|階$|番館|号館|号棟|棟$|館$|丁目|戸建|貸家|住居|新築|駐車場|費用|保険|マンション|ハイツ|荘$|寮$/;
function buildPlaces(withLearned = true): Set<string> {
  const s = new Set<string>();
  const add = (w: string | null | undefined) => {
    const t = String(w ?? "").normalize("NFKC").replace(/[\s　]/g, "").replace(/駅$/, "");
    if (!t || !/[一-龯々]/.test(t)) return;
    s.add(t);
    s.add(t.replace(/ヶ|ケ|ヵ/g, "ヶ")); s.add(t.replace(/ヶ|ヵ/g, "ケ"));
    // 「谷町四丁目」→「谷町」・「天神橋筋六丁目」→「天神橋筋」「天神橋」
    const m = t.match(new RegExp(`^(.+?)[${KANJI_NUM}0-9]+丁目$`));
    if (m) { s.add(m[1]); s.add(m[1].replace(/筋$/, "")); }
    // 「大阪市北区」→「北区」は短いので入れない。「豊中市」→「豊中」・「堺市堺区」→「堺」
    const w2 = t.replace(/^(?:大阪府|兵庫県|京都府)?(?:大阪市|堺市)?/, "").replace(/[市区町村]$/, "");
    if (w2.length >= 2) s.add(w2);
  };
  for (const st of Object.values(LINES)) for (const x of st) add(x);
  for (const k of Object.keys(EXT_STATION_WARD_MAP)) add(k);
  for (const k of Object.keys(EXT_NEIGHBORHOOD_WARD_MAP)) add(k);
  for (const [k, v] of Object.entries(ALIASES)) { add(k); add(v); }
  for (const k of WARD_COORDS.keys()) add(k);
  // 覚えた並びのうち建物の印・地名でない語（番館・号棟・丁目戸建・住居・新築・駐車場 等）は地名にしない（「参番館」を「壱番館」に直す元になった）
  if (withLearned) for (const k of LEARNED_PLACE_TOKENS) if (!NOT_PLACE_RE.test(k)) add(k);
  return s;
}
let PLACES: Set<string> | null = null;
export function placeSet(): Set<string> { return (PLACES ??= buildPlaces()); }
/** 地名の表（駅・町名・区市）だけ（資料の文字から覚えた並びを除く・覚える側の scripts が使う） */
export function basePlaceSet(): Set<string> { return buildPlaces(false); }

/** 漢字の並び（地名の候補）。「夕陽ヶ丘」「住ノ江」のように間の ヶ・ノ・の も含める */
const RUN_RE = /[一-龯々〆]+(?:[ヶケヵノの][一-龯々]+)*/g;
export function kanjiRuns(name: string): Array<{ text: string; index: number }> {
  return [...String(name ?? "").matchAll(RUN_RE)].map((m) => ({ text: m[0], index: m.index ?? 0 }));
}

/** 地名として読めるか（表にある・表の地名の並び・頭尻の字だけ足した形）。2字未満は判断しない（true） */
export function isKnownPlaceToken(token: string, places: Set<string> = placeSet()): boolean {
  const t = token.normalize("NFKC");
  if (Array.from(t).length < 2) return true;
  if (places.has(t)) return true;
  // 区切り（DP）: 表の地名と頭尻の字（AFFIX）を並べて全体を覆えるか。地名が1つは要る
  const cs = Array.from(t);
  const n = cs.length;
  const best: Array<number | null> = Array(n + 1).fill(null); // その位置までに使った地名の数（覆えない時 null）
  best[0] = 0;
  for (let i = 0; i < n; i++) {
    if (best[i] === null) continue;
    for (let j = i + 1; j <= n; j++) {
      const piece = cs.slice(i, j).join("");
      const isPlace = j - i >= 2 && places.has(piece);
      const isAffix = AFFIX.has(piece) || /^[0-9一二三四五六七八九十壱弐参]+(?:丁目|番館|号館|番|号)?$/.test(piece);
      if (!isPlace && !isAffix) continue;
      const v = (best[i] as number) + (isPlace ? 1 : 0);
      if (best[j] === null || (best[j] as number) < v) best[j] = v;
    }
  }
  return (best[n] ?? 0) >= 1;
}

// ───────────── 旧字・化けの癖 ─────────────
/** 地名の旧字（名前には普通にあるので、地名の表と合う時だけ新字にする） */
const OLD_PLACE_CHARS: Record<string, string> = { "國": "国", "條": "条", "濱": "浜", "澤": "沢", "淺": "浅", "邊": "辺", "邉": "辺", "髙": "高", "﨑": "崎", "瀨": "瀬", "藏": "蔵", "龍": "竜", "萬": "万", "櫻": "桜", "廣": "広", "曾": "曽", "雜": "雑" };
function foldOld(t: string): string { return Array.from(t).map((c) => OLD_PLACE_CHARS[c] ?? c).join(""); }

/** 化けの癖の表（地名の並び→正しい地名・見た回数）。build-property-name-ledger.ts が実例から作る */
const CONFUSION_MAP: Map<string, { to: string; n: number }> = new Map(CONFUSION_TOKENS.map(([from, to, n]) => [from, { to, n }]));
/** 確かな化け（帳簿で確かめなくても直す）: 3回以上見て、逆向き（正しい地名が化けとして読まれた）が無い */
export const CONFUSION_SURE_MIN = 3;

function editDistance(a: string, b: string, cap = 3): number {
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

export type PlaceFix = { from: string; to: string; via: "old_form" | "confusion" | "one_char"; sure: boolean };
/**
 * 表に無い地名の並び → 直す候補（1つに決まる時だけ・決まらなければ null）。
 *   ① 旧字を新字にすると表にある（大國町→大国町）＝確か
 *   ② 化けの癖の表にある（雑賀→難波）＝3回以上なら確か
 *   ③ 表の地名と同じ長さで1字だけ違う物が1つだけ（梅出→梅田・戸原橋→芦原橋・令福→今福）＝帳簿で確かめる（確かではない）
 *      地名＋頭尻の字（「令福」は表の「今福」・「速里小野」は「遠里小野」）も同じ長さの1字違いで探す
 */
export function placeFixCandidate(token: string, places: Set<string> = placeSet()): PlaceFix | null {
  const t = token.normalize("NFKC");
  if (isKnownPlaceToken(t, places)) return null;
  const folded = foldOld(t);
  if (folded !== t && isKnownPlaceToken(folded, places)) return { from: t, to: folded, via: "old_form", sure: true };
  // 化けの癖の表（旧字を新字にした形でも引く・表の化け＋頭尻の字「雑賀西」→「難波西」も）
  for (const key of new Set([t, folded])) {
    const conf = CONFUSION_MAP.get(key);
    if (conf && isKnownPlaceToken(conf.to, places)) return { from: t, to: conf.to, via: "confusion", sure: conf.n >= CONFUSION_SURE_MIN };
    for (const [from, c] of CONFUSION_MAP) {
      if (Array.from(from).length < 2 || !key.startsWith(from)) continue;
      const rest = key.slice(from.length);
      if (rest && (AFFIX.has(rest) || places.has(rest)) && isKnownPlaceToken(c.to + rest, places)) return { from: t, to: c.to + rest, via: "confusion", sure: c.n >= CONFUSION_SURE_MIN };
    }
  }
  const len = Array.from(t).length;
  if (len < 2) return null;
  const hits = new Set<string>();
  for (const p of places) {
    if (Array.from(p).length !== len) continue;
    if (editDistance(p, t, 1) === 1) hits.add(p);
    if (hits.size > 1) return null;
  }
  // 地名＋頭尻（「南堀江」の頭・「谷町四丁目」の尻）も同じ長さの1字違いで（表の地名そのものが1つも当たらない時だけ）
  if (!hits.size) {
    const cs = Array.from(t);
    for (let i = 0; i < len; i++) {
      for (const c of new Set(Array.from(placesChars(places)))) {
        if (c === cs[i]) continue;
        const v = [...cs.slice(0, i), c, ...cs.slice(i + 1)].join("");
        if (isKnownPlaceToken(v, places) && v !== t) { hits.add(v); if (hits.size > 1) return null; }
      }
    }
  }
  if (hits.size !== 1) return null;
  return { from: t, to: [...hits][0], via: "one_char", sure: false };
}
let PLACE_CHARS: string | null = null;
function placesChars(places: Set<string>): string {
  if (PLACE_CHARS) return PLACE_CHARS;
  const cs = new Set<string>();
  for (const p of places) for (const c of Array.from(p)) if (/[一-龯々]/.test(c)) cs.add(c);
  return (PLACE_CHARS = [...cs].join(""));
}

// ───────────── 帳簿 ─────────────
/** 帳簿の1行（建物の鍵ごと）。出所: text＝資料の文字（売上サポの行）／staff＝スタッフの入力・送った本文（AIX の記録）／shared＝グループに共有した物件（merge-pdfs）／read＝画像の読み取り */
export type LedgerSource = "text" | "staff" | "shared" | "read";
export type LedgerEntry = { name: string; key: string; marks: string; counts: Partial<Record<LedgerSource, number>> };
/**
 * 信頼できる行か（資料の文字とスタッフの入力ほど信頼）:
 *   資料の文字が1回でもある／スタッフの入力が2回以上／出所を合わせて3回以上（読み取りは数えない）
 */
export function ledgerTrusted(e: LedgerEntry): boolean {
  const c = e.counts;
  if ((c.text ?? 0) >= 1) return true;
  if ((c.staff ?? 0) >= 2) return true;
  return (c.text ?? 0) + (c.staff ?? 0) + (c.shared ?? 0) >= 3;
}
/** 名前の並び（出所つき）から帳簿を作る。同じ建物の鍵は1行にまとめ、一番多く出た書き方を名前にする */
export function buildLedger(rows: ReadonlyArray<{ name: string | null | undefined; source: LedgerSource }>): LedgerEntry[] {
  const by = new Map<string, LedgerEntry & { names: Map<string, number> }>();
  for (const r of rows) {
    const raw = toJapaneseKanji(String(r.name ?? "").trim());
    const p = parseLoose(raw);
    if (!p || Array.from(p.key).length < 3) continue;
    const e = by.get(p.key) ?? { name: raw, key: p.key, marks: p.marks, counts: {} as Partial<Record<LedgerSource, number>>, names: new Map<string, number>() };
    e.counts[r.source] = (e.counts[r.source] ?? 0) + 1;
    // 名前の書き方: 号室（3字以上の数字か「号室」）だけ外す（建物の番号「Luxe難波西2」は残す）・★の飾りは外す
    const bare = splitRoomTail(raw).building.replace(/^[★☆🌟\s]+|[★☆\s]+$/gu, "").trim() || raw;
    e.names.set(bare, (e.names.get(bare) ?? 0) + (r.source === "text" ? 3 : r.source === "staff" ? 2 : 1));
    by.set(p.key, e);
  }
  return [...by.values()].map(({ names, ...e }) => ({ ...e, name: [...names].sort((a, b) => b[1] - a[1])[0]?.[0] ?? e.name }));
}

// ───────────── 名前の直し ─────────────
export type NameFixResult = {
  name: string;
  status: "known" | "fixed" | "uncertain" | "unchanged";
  /** 直した時の理由（place:old_form／place:confusion／place:one_char+ledger／series+ledger） */
  rule?: string;
  from?: string;
  /** 迷った時の候補（多くて3） */
  candidates?: string[];
};

/** 号室・階の尻を分ける（直すのは建物名だけ・号室はそのまま戻す） */
function splitRoomTail(name: string): { building: string; tail: string } {
  const m = name.match(/^(.*?\S)(\s*(?:[A-Za-z]?[-‐－]?[0-9０-９]{1,5}\s*(?:号室|号)?|[0-9０-９]{1,2}\s*階.*))$/);
  if (!m || !/[^\d\s]/.test(m[1])) return { building: name, tail: "" };
  // 建物名の末尾の番号（「Luxe難波西2」「SUN生二番館」）は号室ではない＝3字以上の数字か「号室」がある時だけ尻にする
  if (!/号|階/.test(m[2]) && !/[0-9０-９]{3,}/.test(m[2])) return { building: name, tail: "" };
  return { building: m[1], tail: m[2] };
}

/**
 * 読んだ物件名を直す。帳簿（ledger）は信頼できる行だけを候補にする。
 * @param ledger 帳簿（buildLedger）。空でもよい（地名の確かな直しだけ効く）
 */
export function fixReadPropertyName(read: string | null | undefined, ledger: ReadonlyArray<LedgerEntry>, env: Record<string, string | undefined> = process.env): NameFixResult {
  const orig = String(read ?? "").trim();
  const name0 = toJapaneseKanji(orig);
  if (!name0 || !propertyNameFixEnabled(env)) return { name: name0 || orig, status: "unchanged" };
  const { building, tail } = splitRoomTail(name0);
  const me = parseLoose(building);
  if (!me || Array.from(me.key).length < 3) return { name: name0, status: "unchanged" };
  const trusted = ledger.filter(ledgerTrusted);
  const byKey = new Map(trusted.map((e) => [e.key, e]));
  // A 帳簿にある
  if (byKey.has(me.key)) return { name: name0, status: "known" };

  const places = placeSet();
  const runs = kanjiRuns(building);
  const unknownRuns = runs.filter((r) => !NOT_PLACE_RE.test(r.text) && !isKnownPlaceToken(r.text, places));

  // B 地名の直し
  if (unknownRuns.length) {
    const fixes = unknownRuns.map((r) => ({ r, f: placeFixCandidate(r.text, places) }));
    if (fixes.every((x) => x.f)) {
      let fixed = building;
      for (const { r, f } of [...fixes].sort((a, b) => b.r.index - a.r.index)) fixed = fixed.slice(0, r.index) + f!.to + fixed.slice(r.index + r.text.length);
      const fk = parseLoose(fixed);
      const inLedger = !!fk && byKey.has(fk.key);
      const sure = fixes.every((x) => x.f!.sure);
      if (inLedger || sure) {
        const rule = `place:${[...new Set(fixes.map((x) => x.f!.via))].join("+")}${inLedger ? "+ledger" : ""}`;
        return { name: (inLedger ? byKey.get(fk!.key)!.name : fixed) + tail, status: "fixed", rule, from: name0 };
      }
    }
  }
  // B' 地名を直さずに帳簿へ: 地名が表に無い時、帳簿の名前で「シリーズ名が同じ・地名の並びだけ違う（1〜2字）」物が1つ
  //   （「エスリード雑賀サプライト」→「エスリード難波ザブライト」のように片仮名も少し違う物は C で）
  const samePlaces = (a: string, b: string) => kanjiRuns(a).map((r) => r.text).join("|") === kanjiRuns(b).map((r) => r.text).join("|");
  const len = Array.from(me.key).length;
  const near = trusted.filter((e) => e.marks === me.marks && Math.abs(Array.from(e.key).length - len) <= 2)
    .map((e) => ({ e, d: editDistance(e.key, me.key, 3) }))
    .filter((x) => x.d <= (len >= 10 ? 2 : 1) || (unknownRuns.length > 0 && x.d <= 2));
  if (!near.length) return { name: name0, status: unknownRuns.length ? "uncertain" : "unchanged" };
  const best = Math.min(...near.map((x) => x.d));
  const top = near.filter((x) => x.d === best);
  if (top.length !== 1) return { name: name0, status: "uncertain", candidates: top.slice(0, 3).map((x) => x.e.name) };
  const cand = top[0].e;
  if (unknownRuns.length) {
    // 地名が表に無い: 帳簿の候補の地名が表にあり、違いがその地名の並びの中だけ（シリーズ名・尻は同じ）の時
    const candRuns = kanjiRuns(cand.name);
    const okPlace = candRuns.every((r) => isKnownPlaceToken(r.text, places));
    const strip = (s: string) => s.replace(RUN_RE, "＊").normalize("NFKC").replace(/[\s　・]/g, "").toLowerCase();
    const sa = strip(cand.name), sb = strip(building);
    // 2026-10-14 全件を目で読んだ直し: 違う地名の並びは「似ている」時だけ（1字違い・同じ長さで半分以下の違い）。
    //   似ていない（プレステージ日向→中宮・リアライズ小島→玉出・クリエオーレ葛連→長橋・深江橋第二コーポ→深江橋コーポ）は同じシリーズの別の建物
    //   表にある並び・建物の印（参番館・B棟）は同じ字のままの時だけ（違うのは表に無い地名の並びだけ）
    const pairsAlike = runs.every((r, i) => r.text === candRuns[i]?.text || (unknownRuns.includes(r) && placeRunsAlike(r.text, candRuns[i]?.text ?? "")));
    if (okPlace && candRuns.length === runs.length && pairsAlike && (sa === sb || (Array.from(sa).length >= 6 && editDistance(sa, sb, 1) <= 1))) {
      return { name: cand.name + tail, status: "fixed", rule: "place+ledger", from: name0 };
    }
    return { name: name0, status: "uncertain", candidates: [cand.name] };
  }
  // C 地名は表にあり同じ・シリーズ名（片仮名・英字）だけ違う
  if (!samePlaces(building, cand.name)) return { name: name0, status: "unchanged" };
  // 短い名前（MRS→MARS・ダイレ・エス→ダイレ・エヌ＝鍵5字以下）・片方が片方の頭（カーザSun→カーザSun I・ハイツカトレア→ハイツカトレア B）・建物の番号が違う物は寄せない
  const [ka, kb] = [me.key, cand.key];
  // fix(review): 地名の並びが1つも無い名前（ガーデンプラッツ・グラスフィールド・エムズスイツ・メゾン ド ボヌール）は、
  //   片仮名1〜2字違いの実在する別の建物と見分ける手がかりが無い＝寄せない（確かではない）
  if (!runs.length) return { name: name0, status: "uncertain", candidates: [cand.name] };
  if (Math.min(Array.from(ka).length, Array.from(kb).length) < 6 || ka.startsWith(kb) || kb.startsWith(ka) || buildingNumeralOf(building) !== buildingNumeralOf(cand.name) || unitMarks(building) !== unitMarks(cand.name)) {
    return { name: name0, status: "uncertain", candidates: [cand.name] };
  }
  return { name: cand.name + tail, status: "fixed", rule: "series+ledger", from: name0 };
}

/** 2つの地名の並びが「読み違いで起きる程度に似ている」か（1字違い・同じ長さで半分以下の違い） */
export function placeRunsAlike(a: string, b: string): boolean {
  if (!a || !b) return false;
  const la = Array.from(a).length, lb = Array.from(b).length, d = editDistance(a, b, 3);
  if (d <= 1 || (la === lb && d * 2 <= la)) return true;
  // 同じ長さで、違う字どうしがどれも字の化けの癖（2つ以上の建物で見た組・鶴渡→難波 の 鶴→難・渡→波）
  if (la !== lb) return false;
  const x = Array.from(a), y = Array.from(b);
  return x.every((c, i) => c === y[i] || CHAR_CONF.has(c + "→" + y[i]));
}
const CHAR_CONF = new Set(CONFUSION_CHARS.map(([a, b]) => a + "→" + b));
/** 棟・館の印（「B棟」「参番館」「2号館」「EAST」）。違えば別の建物 */
function unitMarks(name: string): string {
  const t = String(name ?? "").normalize("NFKC");
  const xs = [...t.matchAll(/([A-Za-z]|[0-9]+|[一二三四五六七八九十壱弐参]+)\s*(?:号棟|番館|号館|棟|館)/g)].map((m) => m[1].toUpperCase());
  return xs.sort().join(",");
}
/** 建物の末尾の番号（Ⅱ・III・2・二・弐）。property-name-match.buildingNumeral に漢数字を足した物 */
function buildingNumeralOf(name: string): string {
  const t = String(name ?? "").normalize("NFKC").replace(/[\s　・()（）「」\-−ー_/／★☆]+$/g, "").replace(/(?:号館|番館|棟)$/, "");
  const roman: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
  const kan: Record<string, string> = { 一: "1", 壱: "1", 二: "2", 弐: "2", 三: "3", 参: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9", 十: "10" };
  const m = t.match(/(?:^|[^A-Za-z])(I{1,3}|IV|VI{0,3}|IX|X)$/i);
  if (m) return roman[m[1].toLowerCase()] ?? "";
  const d = t.match(/(?:^|[^0-9])([0-9]{1,2})$/);
  if (d) return String(parseInt(d[1], 10));
  const k = t.match(/第?([一壱二弐三参四五六七八九十])$/);
  return k ? kan[k[1]] : "";
}

/** 駅の名前だけ直す（読み取りの facts.station・地名の表で1つに決まる確かな直しだけ＝旧字・3回以上の化け） */
export function fixReadStationName(station: string | null | undefined, env: Record<string, string | undefined> = process.env): string | null {
  const s = toJapaneseKanji(String(station ?? "").trim());
  if (!s || !propertyNameFixEnabled(env)) return s || null;
  const f = placeFixCandidate(s.replace(/駅$/, ""));
  return f && f.sure ? f.to : s;
}
