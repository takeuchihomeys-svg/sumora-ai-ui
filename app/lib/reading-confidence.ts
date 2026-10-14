// app/lib/reading-confidence.ts（純関数・DB 依存なし・サーバー専用＝property-name-fix の地名の表が大きいので画面から import しない）
// 画像の読み取りの「怪しい印」（確信度のゲート）。印がある欄だけ深く調べ直す（拡大して読み直す・売上サポの行と照らす）。
//
// 2026-10-14 竹内さん（設計知見 56ecf24a・P1）「自信が無い時・根拠が見つからない時だけ深く調べる。全部に毎回かけない（質が上がり API の無駄も無い）」
//   最初の読み取りは今まで通り1回。印の決め方は scripts/audit-reading-confidence.ts（保存済みの読み取り × 売上サポの行）で数えて決めた。
// 戻す: READING_CONFIDENCE=off（印を出さない＝読み直し・照らしが1つも走らない）
import { kanjiRuns, isKnownPlaceToken, NOT_PLACE_RE, placeSet, placeRunsAlike, type NameFixResult } from "./property-name-fix";
import { parseLoose } from "./property-name-loose";
import { similarity, normalizePropertyName } from "./property-name-match";
import { canonicalRoomNo } from "./room-no";

export function readingConfidenceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.READING_CONFIDENCE ?? "").trim().toLowerCase() !== "off";
}

// ───────────── 物件名 ─────────────
export type NameSignal = "fix_uncertain" | "multi_candidates" | "unknown_place" | "not_in_ledger";
/**
 * 物件名の印（直し property-name-fix の後の名前で見る）。
 *   fix_uncertain   … 直しが迷った（地名が表に無く直せない・帳簿に似た名前があるが1つに決められない）
 *   multi_candidates… 帳簿に似た名前が2つ以上
 *   unknown_place   … 漢字の並びが地名の表に無い（直した後も）
 *   not_in_ledger   … 帳簿に無いだけ（怪しい所は無い＝新しい物件が普通にこれ）。読み直しの印にはしない（数えるだけ）
 */
export function nameSignals(read: string, fixed: NameFixResult): NameSignal[] {
  const out: NameSignal[] = [];
  if (fixed.status === "known" || fixed.status === "fixed") return out;
  if (fixed.status === "uncertain") out.push("fix_uncertain");
  if ((fixed.candidates?.length ?? 0) >= 2) out.push("multi_candidates");
  const places = placeSet();
  if (kanjiRuns(fixed.name || read).some((r) => !NOT_PLACE_RE.test(r.text) && !isKnownPlaceToken(r.text, places))) out.push("unknown_place");
  if (!out.length) out.push("not_in_ledger");
  return out;
}
/** 読み直しの引き金にする物件名の印（not_in_ledger は数えるだけ） */
export const NAME_TRIGGER: ReadonlySet<NameSignal> = new Set<NameSignal>(["fix_uncertain", "multi_candidates", "unknown_place"]);

// ───────────── 号室 ─────────────
export type RoomSignal = "room_letters" | "room_plan" | "room_text" | "room_digits" | "room_tail" | "room_floor";
/**
 * 号室の印（読んだ形のまま見る）。
 *   room_plan    … 間取りの形（「1K」「2LDK」）＝間取りの欄を号室に読んだ
 *   room_text    … 号室に日本語（「6階8分」「号室不記載」）
 *   room_letters … 数字の中に英字（「1O1」「5K3」）・頭／尻の1字（B-102・3C）以外の英字
 *   room_digits  … 数字だけで 5字以上（号室の普通は 1〜4字。1字の「2」・英字つきの「3A」は小さな建物に本当にある＝印にしない）
 *   room_tail    … 3字以上の号室で下2桁が 40 以上（1つの階に40室は無い＝「3077」）
 *   room_floor   … 号室の階が建物の階数を超える（建物の階数が分かる時だけ）
 */
export function roomSignals(room: string | null | undefined, opts: { totalFloors?: number | null } = {}): RoomSignal[] {
  const s = String(room ?? "").normalize("NFKC").trim().replace(/\s*(?:号室|号)$/, "");
  if (!s || /^(?:null|undefined)$/i.test(s)) return [];
  const out: RoomSignal[] = [];
  if (/^\d[SLDKR]{1,4}$/i.test(s) || /^\d\s*(?:LDK|DK|SLDK)\b/i.test(s)) out.push("room_plan");
  else if (/[぀-ヿ一-龯]/.test(s)) out.push("room_text");
  // 「2F-C」「6FA」（階＋英字の部屋）は本当にある号室の形（拡大して読み直しても同じだった・verify-reading-recheck.ts）
  //   英字だけ（「A」「B」）も小さな建物の部屋の名前に本当にある＝印にしない
  const ok = /^[A-Za-z]{0,2}[-‐－]?\d+$|^\d+[-‐－]?[A-Za-z]$|^\d{1,2}F[-‐－]?[A-Za-z]$|^[A-Za-z]{1,2}$/i.test(s);
  if (!ok && !out.length && /[A-Za-z|]/.test(s)) out.push("room_letters");
  if (/^\d{5,}$/.test(s)) out.push("room_digits");
  const num = canonicalRoomNo(s, {}).match(/^(?:[A-Z]{1,2}-?)?(\d{3,})$/)?.[1];
  if (num && Number(num.slice(-2)) >= 40) out.push("room_tail");
  if (opts.totalFloors && ok) {
    const c = canonicalRoomNo(s, {}).replace(/^[A-Z]{1,2}-?/, "").replace(/[A-Z]$/, "");
    const fl = c.length >= 3 ? Number(c.slice(0, c.length - 2)) : NaN;
    if (Number.isFinite(fl) && fl > opts.totalFloors) out.push("room_floor");
  }
  return out;
}

// ───────────── 敷金・礼金の単位 ─────────────
export type AmountSignal = "deposit_unit" | "key_money_unit";
type UnitFacts = { rent?: number | null; deposit_months?: number | null; deposit_yen?: number | null; key_money_months?: number | null; key_money_yen?: number | null; [k: string]: unknown };
/**
 * 敷金・礼金の単位の印: 敷金の読んだ値が 1〜3 の整数の月数（「2」が 2ヶ月か 2万円か見分けられない）。
 *   礼金は印にしない: 「礼金1ヶ月」がとても多く、1〜3 の整数を全部印にすると読み取りの 22% に読み直しが走るのに、
 *   単位の取り違えは 86件中 2（scripts/audit-reading-confidence.ts・2026-10-14）。敷金は 7件中 2・印は読み取りの 2.4%。
 *   敷金の読み直しで礼金の欄も一緒に読む（同じ1回）。0（なし）・端数は印にしない（「万円」の端数は reading-amounts が直す）
 *   READING_CONFIDENCE_KEY_MONEY=on で礼金の 1〜3 も印にする
 */
export function amountUnitSignals(f: UnitFacts, env: Record<string, string | undefined> = process.env): AmountSignal[] {
  const out: AmountSignal[] = [];
  const amb = (m: unknown) => typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= 3;
  if (amb(f.deposit_months)) out.push("deposit_unit");
  if ((env.READING_CONFIDENCE_KEY_MONEY ?? "").trim().toLowerCase() === "on" && amb(f.key_money_months)) out.push("key_money_unit");
  return out;
}

/**
 * 読み直した敷金・礼金の欄の文字（「2ヶ月」「2万円」「20,000円」「なし」「-」）の単位を読む。
 *   数字だけ（「2」）・読めない → unclear（決めない）
 */
export function parseAmountText(text: string | null | undefined): { unit: "months" | "yen" | "none" | "unclear"; months?: number; yen?: number } {
  const t = String(text ?? "").normalize("NFKC").replace(/[,，\s]/g, "");
  if (!t) return { unit: "unclear" };
  if (/^(?:なし|無し|無|ナシ|0|0円|0ヶ月|[-ー－—―‐])$/.test(t)) return { unit: "none", months: 0 };
  const man = t.match(/^(\d+(?:\.\d+)?)万(?:円)?/);
  if (man) return { unit: "yen", yen: Math.round(parseFloat(man[1]) * 10000) };
  const yen = t.match(/^(\d{3,})円/) ?? t.match(/^¥(\d{3,})/);
  if (yen) return { unit: "yen", yen: parseInt(yen[1], 10) };
  const mo = t.match(/^(\d+(?:\.\d+)?)(?:ヶ月|か月|カ月|ケ月|ヵ月|ヶ|カ|ケ|ヵ|月)/);
  if (mo) return { unit: "months", months: parseFloat(mo[1]) };
  return { unit: "unclear" };
}

// ───────────── 売上サポの行と照らす（賃料・㎡・間取り） ─────────────
export type AttrRow = {
  property_name: string | null; room_no: string | null; rent: number | null; area_sqm: number | null;
  floor_plan?: string | null; total_floors?: number | null; deposit_months?: number | null; key_money_months?: number | null;
};
export type AttrHit = { name: string; key: string; rooms: string[]; sameRoom: boolean; totalFloors: number | null; depositMonths: number | null; keyMoneyMonths: number | null; rows: number };
const planNorm = (p: string | null | undefined) => String(p ?? "").normalize("NFKC").toUpperCase().replace(/ワンルーム|^1R$/, "1R").replace(/\s/g, "");
const mode = <T,>(xs: T[]): T | null => {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  let best: T | null = null, n = 0;
  for (const [k, v] of m) if (v > n) { best = k; n = v; }
  return best;
};
/**
 * 賃料が同じ・㎡が ±0.05・（両方あれば）間取りが同じ売上サポの行を集め、建物が1つに決まる時だけ返す（2つ以上・0 は null）。
 *   号室も合わせて読んだ時（room）は、その号室の行の敷金・礼金を返す（無ければ建物の行の多数）
 */
export function lookupByAttributes(rows: ReadonlyArray<AttrRow>, q: { rent: number | null; areaSqm: number | null; floorPlan?: string | null; room?: string | null }): AttrHit | null {
  if (!q.rent || !q.areaSqm) return null;
  const qp = planNorm(q.floorPlan);
  const hits = rows.filter((r) => r.rent === q.rent && r.area_sqm != null && Math.abs(Number(r.area_sqm) - q.areaSqm!) <= 0.05
    && (!qp || !r.floor_plan || planNorm(r.floor_plan) === qp));
  if (!hits.length) return null;
  const byKey = new Map<string, AttrRow[]>();
  for (const h of hits) { const p = parseLoose(h.property_name); if (!p) continue; byKey.set(p.key, [...(byKey.get(p.key) ?? []), h]); }
  if (byKey.size !== 1) return null;
  const [key, rs] = [...byKey][0];
  const rooms = [...new Set(rs.map((r) => canonicalRoomNo(r.room_no ?? "", {})).filter(Boolean))];
  const room = q.room ? canonicalRoomNo(q.room, {}) : "";
  const sameRoom = room ? rs.filter((r) => canonicalRoomNo(r.room_no ?? "", {}) === room) : [];
  const src = sameRoom.length ? sameRoom : rs;
  const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
  return {
    name: mode(rs.map((r) => String(r.property_name ?? "").trim()).filter(Boolean)) ?? "",
    key, rooms, sameRoom: sameRoom.length > 0,
    totalFloors: mode(rs.map((r) => num(r.total_floors)).filter((x): x is number => x != null && Number.isFinite(x))),
    depositMonths: mode(src.map((r) => num(r.deposit_months)).filter((x): x is number => x != null && Number.isFinite(x))),
    keyMoneyMonths: mode(src.map((r) => num(r.key_money_months)).filter((x): x is number => x != null && Number.isFinite(x))),
    rows: rs.length,
  };
}

/**
 * 賃料・㎡・間取りで1つに決まった売上サポの建物（hit）の名前に、怪しい読んだ名前を直す案。
 *   ・名前が似ている（similarity ≥ minSim）・区別の印（数字・ローマ数字・方角）が同じ時だけ（似ていない＝偶然同じ賃料・㎡の別の建物）
 *   ・placeless: 読んだ名前に漢字の並び（地名）が無い（片仮名・英字だけ）。呼び出し側で別のスイッチを見る（竹内さんと打ち合わせ中）
 *   直さない時は null
 */
export function attrNameFix(read: string, hit: AttrHit | null, opts: { minSim?: number } = {}): { name: string; sim: number; placeless: boolean } | null {
  if (!hit || !hit.name) return null;
  const name = cleanPickupName(hit.name);
  const a = parseLoose(read), b = parseLoose(name);
  if (!a || !b || a.key === b.key) return null;
  if (a.marks !== b.marks) return null;
  const sim = similarity(normalizePropertyName(read), normalizePropertyName(name));
  if (sim < (opts.minSim ?? ATTR_FIX_MIN_SIM)) return null;
  // 地名（漢字の並び）が違う時は、読んだ並びが地名の表に無い（化け）か、読み違いで起きる程度に似ている時だけ
  //   （表にある別の地名＝同じシリーズの別の建物「エステムコート梅田／難波」に寄せない・property-name-fix の線と同じ）
  const ra = kanjiRuns(read).map((r) => r.text), rb = kanjiRuns(name).map((r) => r.text);
  if (ra.length !== rb.length) return null;
  const places = placeSet();
  if (!ra.every((x, i) => x === rb[i] || !isKnownPlaceToken(x, places) || placeRunsAlike(x, rb[i]))) return null;
  return { name, sim, placeless: kanjiRuns(read).length === 0 };
}
/** 住所（賃料・㎡・間取り）の照らしで直す時の名前の近さの下限（scripts/audit-reading-confidence.ts で決めた） */
export const ATTR_FIX_MIN_SIM = 0.5;

/** 売上サポの行の名前の飾り（頭の■・尻の読み仮名（アンリュウソウ）・階の幅「2-8F」）を外す */
export function cleanPickupName(name: string): string {
  return String(name ?? "").normalize("NFKC").replace(/^[■□◆◇●○★☆【\s]+/, "")
    .replace(/\s*[(（][ァ-ヶー・\s]+[)）]\s*$/, "").replace(/\s+\d{1,2}\s*[-~〜]\s*\d{1,2}\s*F$/i, "").replace(/\s+/g, " ").trim();
}

// ───────────── 読み直しの結果を使うか（どれも「確かな時だけ」・迷えば1回目のまま） ─────────────

/**
 * 物件名: 読み直した名前を直し（property-name-fix）にかけ、帳簿にある（known）か確かに直せた（fixed）時だけ使う。
 *   1回目と同じ建物なら変えない（null）。帳簿に無い名前どうしの入れ替え（怪しい→怪しい）はしない
 */
export function adoptRecheckedName(first: NameFixResult, again: NameFixResult | null): { name: string; rule: string } | null {
  if (!again || !again.name) return null;
  if (again.status !== "known" && again.status !== "fixed") return null;
  const a = parseLoose(first.name), b = parseLoose(again.name);
  if (!b || (a && a.key === b.key)) return null;
  return { name: again.name, rule: `recheck:${again.status}${again.rule ? `:${again.rule}` : ""}` };
}

/**
 * 号室: 読み直した号室が普通の号室の形（印なし・1〜4字の数字＋頭／尻の英字）で、1回目と違う時だけ使う。
 *   1回目が号室の数字として読めていた物（下2桁が40以上「3077」・5字以上）は、読み直しが1回目と1字の足し引き・入れ替えの時だけ
 *   （3077→307・140→1402）＝まったく別の数（3077→202）には変えない
 */
export function adoptRecheckedRoom(first: string | null | undefined, again: string | null | undefined): string | null {
  const c = canonicalRoomNo(again ?? "", {});
  if (!c || roomSignals(again).length) return null;
  if (!/^(?:[A-Z]{1,2}-?)?\d{1,4}[A-Z]?$/.test(c)) return null;
  const f = canonicalRoomNo(first ?? "", {});
  if (c === f) return null;
  const sig = roomSignals(first);
  if (sig.includes("room_tail") || sig.includes("room_digits")) {
    const a = f.replace(/\D/g, ""), b = c.replace(/\D/g, "");
    const oneEdit = a.startsWith(b) && a.length - b.length === 1 || b.startsWith(a) && b.length - a.length === 1
      || (a.length === b.length && [...a].filter((ch, i) => ch !== b[i]).length === 1);
    if (!oneEdit) return null;
  }
  return c;
}

/** 敷金・礼金の単位の決め方の結果。facts に足す印（unclear）は「断定するか確認の約束にするかはブレインが決める」材料 */
export type UnitKind = "deposit" | "key_money";
export type UnitResolution = { facts: Record<string, unknown>; changes: string[]; unclear: UnitKind[] };
function setAmount(o: Record<string, unknown>, k: UnitKind, v: { months?: number; yen?: number }): void {
  delete o[`${k}_months`]; delete o[`${k}_yen`];
  if (v.months != null) o[`${k}_months`] = v.months; else if (v.yen != null) o[`${k}_yen`] = v.yen;
}
/**
 * ① 同じ部屋の売上サポの行（hit.sameRoom）があれば、その月数に合わせる（資料の文字の層＝正）。
 *   建物は読んだ名前と同じ鍵の時だけ（別の建物の行に合わせない）。片方でも資料に値が無ければ①では決めない
 */
export function alignUnitWithPickup(facts: Record<string, unknown>, hit: AttrHit | null, readKey: string | null, kinds: ReadonlyArray<UnitKind>): UnitResolution | null {
  if (!hit || !hit.sameRoom || !readKey || hit.key !== readKey) return null;
  const o = { ...facts }; const changes: string[] = [];
  for (const k of kinds) {
    const t = k === "deposit" ? hit.depositMonths : hit.keyMoneyMonths;
    if (t == null) return null;
    const cur = o[`${k}_months`];
    if (cur === t) continue;
    const was = String(cur ?? o[`${k}_yen`]);
    // 資料の月数は円を賃料で割った値（0.1 刻み）＝読んだ数を万円と見て合えば円で持つ（2 → 20,000円）
    const rent = typeof o.rent === "number" ? o.rent : null;
    if (typeof cur === "number" && rent && Math.abs((cur * 10000) / rent - t) <= 0.1) { setAmount(o, k, { yen: cur * 10000 }); changes.push(`${k}:${was}→${cur * 10000}円(pickup)`); }
    else { setAmount(o, k, { months: t }); changes.push(`${k}:${was}→${t}ヶ月(pickup)`); }
  }
  return { facts: o, changes, unclear: [] };
}
/**
 * ② 読み直した欄の文字で単位を決める（数は1回目と同じ時だけ＝単位だけを決める。数が違う読み直しは使わない）。
 *   ・「2ヶ月」＝1回目の 2 と同じ → 月数で確か（変えない）
 *   ・「2万円」「20,000円」＝1回目の 2 の万円 → 円に直す
 *   ・それ以外（数字だけ・読めない・数が違う・なし）→ 決まらない（unclear・③）
 *   alsoFix: 印の無い欄（礼金）も同じ1回で読んだので、「万円」と分かった時だけ直す（決まらなくても印は付けない）
 */
export function applyRecheckedUnits(facts: Record<string, unknown>, again: { deposit: string; keyMoney: string } | null, kinds: ReadonlyArray<UnitKind>, alsoFix: ReadonlyArray<UnitKind> = []): UnitResolution {
  const o = { ...facts }; const changes: string[] = []; const unclear: UnitKind[] = [];
  for (const k of [...kinds, ...alsoFix.filter((x) => !kinds.includes(x))]) {
    const cur = o[`${k}_months`];
    if (typeof cur !== "number" || !Number.isInteger(cur) || cur < 1 || cur > 3) { if (kinds.includes(k)) unclear.push(k); continue; }
    const p = parseAmountText(again ? (k === "deposit" ? again.deposit : again.keyMoney) : "");
    if (p.unit === "months" && p.months === cur) continue;
    if (p.unit === "yen" && p.yen === cur * 10000) { setAmount(o, k, { yen: p.yen }); changes.push(`${k}:${cur}→${p.yen}円(recheck)`); continue; }
    if (kinds.includes(k)) unclear.push(k);
  }
  return { facts: o, changes, unclear };
}
/** ③ 単位が決まらない欄の印（facts に足す・値は1回目のまま）。読む側は deposit_unit="unclear" を見て「確かではない」と扱う */
export function markUnitUnclear(facts: Record<string, unknown>, kinds: ReadonlyArray<UnitKind>): Record<string, unknown> {
  const o = { ...facts };
  for (const k of kinds) {
    o[`${k}_unit`] = "unclear";
    const m = o[`${k}_months`];
    if (typeof m === "number") o[`${k}_unit_candidates`] = [`${m}ヶ月`, `${m}万円`];
  }
  return o;
}

