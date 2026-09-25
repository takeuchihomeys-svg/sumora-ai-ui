// app/lib/candidate-facts.ts
// 候補の記録（property_candidate_pools.candidates の1件）を「太く」する純関数（DB・ネットに触れない）。
//
// 2026-09-25 竹内「候補の記憶を太くする。会話を見たりオススメしている部分を見ればギャップが分かる」
//   候補の記録に家賃 6.3%・徒歩 0%・AD 34.6% しか残らず、敷礼・築年は項目自体が無かった。
//   そのため「スタッフが選んだ🌟がブレインの点で何位か」を正しく測れなかった。
//
// ■ 決めたこと（設計知見「表示は正しく、記録だけが空」「資料の設備欄を決定論で照らす」に合わせる）
//   ・列は足さず candidates の jsonb の1件に項目を足す（読み手 estimate-profit / property-selection-learning /
//     audit-star-rank が読む既存の鍵 rent・floor_plan・walk_minutes・ad_months・ad_yen の名前と意味は変えない）。
//   ・拡張が画面から読めた値が最優先。無い項目だけ、同じ1件の「生の文字」（cells・bld_text・summary）から読む。
//     生の文字も残す（後で読み方を直した時に読み直せる）。
//   ・どこから埋めたかを src に残す（ext / text / pickup / sent / star_text）。数える時に出どころで分けられる。
//   ・「記載なし」は null（0 にしない）。敷礼の「なし」だけが 0。
//   ・facts_v=2 が太くした後の印（古い行は facts_v 無し）。

export const FACTS_VERSION = 2;

export type Station = { line: string | null; station: string; walk: number };

/** 太くした候補1件（既存の鍵はそのまま。足した鍵は全部 null 許容） */
export type CandidateFacts = {
  rank?: number | null;
  name?: string | null;
  room_no?: string | null;
  /** 家賃（円）。既存の鍵名のまま */
  rent?: number | null;
  admin_fee_yen?: number | null;
  deposit_months?: number | null;
  key_money_months?: number | null;
  deposit_yen?: number | null;
  key_money_yen?: number | null;
  floor_plan?: string | null;
  area_sqm?: number | null;
  /** 築年月 "YYYY-MM"（月が分からなければ "YYYY"） */
  built_ym?: string | null;
  building_age?: number | null;
  stations?: Station[] | null;
  /** 最寄り（徒歩が一番短い駅） */
  station?: string | null;
  walk_minutes?: number | null;
  address?: string | null;
  /** 区（大阪市浪速区→浪速区）。政令市でなければ市（豊中市） */
  ward?: string | null;
  floor?: number | null;
  total_floors?: number | null;
  ad_months?: number | null;
  ad_yen?: number | null;
  /** 設備の語（正規形のラベル） */
  equipment?: string[] | null;
  pdf_url?: string | null;
  /** 🌟（merge-pdfs の順位付けでオススメが付いた）。★ は一番（🌟★） */
  star?: "🌟" | "🌟★" | null;
  facts_v?: number;
  /** 項目ごとの出どころ */
  src?: Record<string, string>;
  [k: string]: unknown;
};

/** 数える・並べる時の項目（監査・カバー率） */
export const FACT_FIELDS = [
  "rent", "admin_fee_yen", "deposit_months", "key_money_months", "floor_plan", "area_sqm", "built_ym", "building_age",
  "station", "walk_minutes", "address", "ward", "floor", "room_no", "ad_months_or_yen", "equipment", "pdf_url", "star",
] as const;
export type FactField = typeof FACT_FIELDS[number];

// ─── 文字の下ごしらえ ────────────────────────────────────────────────────────

export function toHalf(s: string): string {
  return String(s ?? "")
    .replace(/[０-９Ａ-Ｚａ-ｚ．，：／（）％－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ─── 建物名の照合 ────────────────────────────────────────────────────────────

/** 照合用の鍵: 半角・小文字・空白/記号/括弧の中/号室を落とす */
export function nameKey(name: string | null | undefined): string {
  let s = toHalf(String(name ?? "")).toLowerCase();
  s = s.replace(/[（(][^）)]*[）)]/g, "");          // 「オーサムハウス城東(オーサムハウスジョウトウ)」の読み
  s = s.replace(/\s*[a-z]?-?\d{1,4}\s*号室?\s*$/i, ""); // 末尾の号室
  s = s.replace(/\s+\d{2,4}$/, "");                    // 「パレス城北 401」
  s = s.replace(/[\s・･\-‐ー－_.,、。'’"“”!！?？☆★🌟]/gu, "");
  return s;
}
function bigrams(s: string): string[] { const o: string[] = []; for (let i = 0; i < s.length - 1; i++) o.push(s.slice(i, i + 2)); return o; }
/** 建物名の近さ 0〜1（Dice の2文字組）。含む関係（5字以上）は 1 */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const x = nameKey(a), y = nameKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x))) return 1;
  const bx = bigrams(x), by = bigrams(y);
  if (!bx.length || !by.length) return 0;
  const pool = new Map<string, number>();
  for (const g of by) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of bx) { const n = pool.get(g) ?? 0; if (n > 0) { hit++; pool.set(g, n - 1); } }
  return (2 * hit) / (bx.length + by.length);
}
/** 同じ建物とみなす2文字組の近さの線 */
export const SAME_BUILDING_THRESHOLD = 0.75;
/**
 * 同じ建物か。画像の読み取り（sent_properties の vision）は「難波→雑賀」「桑津→美津」のように崩れるので、
 * 2文字組の近さ 0.75 以上も同じとする（一般名「物件」「マンション」は呼び出し側で外す）。
 * ⚠ 0.6 だと同じシリーズの別の建物が当たる（実物: ハーモニーテラス今林↔田島 0.71・アドバンス大阪セレーネ↔グロウ 0.67・
 *   エステムコート難波Ⅶビヨンド↔難波WEST 0.61）。候補が複数ある時は bestBuildingMatch で一番近い物を選ぶ
 */
export function sameBuildingName(a: string | null | undefined, b: string | null | undefined, threshold = SAME_BUILDING_THRESHOLD): boolean {
  return nameSimilarity(a, b) >= threshold;
}

/**
 * 一覧の中で一番近い同じ建物（線 0.75 以上）。号室が両方分かって違う物は外し、号室が同じ物を先にする。無ければ null
 */
export function bestBuildingMatch<T>(name: string | null | undefined, room: string | null | undefined, list: T[], nameOf: (x: T) => unknown, roomOf: (x: T) => unknown): T | null {
  const norm = (r: unknown) => toHalf(String(r ?? "")).replace(/号室?$/, "").replace(/^0+(?=\d)/, "").trim();
  const r0 = norm(room);
  let best: T | null = null, bestScore = -1;
  for (const x of list) {
    const sim = nameSimilarity(name, String(nameOf(x) ?? ""));
    if (sim < SAME_BUILDING_THRESHOLD) continue;
    const r1 = norm(roomOf(x));
    if (r0 && r1 && r0 !== r1) continue;
    const score = sim + (r0 && r1 && r0 === r1 ? 1 : 0);
    if (score > bestScore) { bestScore = score; best = x; }
  }
  return best;
}

/** 物件名の末尾の号室（「グランコート 201号室」「パレス城北 401」→ 201 / 401） */
export function roomFromName(name: string | null | undefined): string | null {
  const s = toHalf(String(name ?? "")).trim();
  const m = s.match(/[\s]*([A-Za-z]?-?\d{1,4})\s*号室?\s*$/) ?? s.match(/\s+([A-Za-z]?\d{2,4})$/);
  return m ? m[1].replace(/^0+(?=\d)/, "") : null;
}

/** 号室 → 階（202→2・1001→10・0901→9・B101 や 2桁は分からない） */
export function floorFromRoomNo(room: string | null | undefined): number | null {
  const s = toHalf(String(room ?? "")).trim();
  if (!/^\d{3,4}$/.test(s)) return null;
  const n = s.length === 3 ? parseInt(s[0], 10) : parseInt(s.slice(0, 2), 10);
  return n >= 1 && n <= 60 ? n : null;
}

// ─── 金額・月数 ──────────────────────────────────────────────────────────────

/** 「58,000円」「5.8万円」「¥58,000」→ 円（読めなければ null） */
export function yenOf(t: string | null | undefined): number | null {
  if (t == null) return null;
  const s = toHalf(String(t)).replace(/,/g, "");
  const m = s.match(/(\d+(?:\.\d+)?)\s*万/);
  if (m) return Math.round(parseFloat(m[1]) * 10000);
  const y = s.match(/¥\s*(\d+)|(\d+)\s*円/);
  if (y) return parseInt(y[1] ?? y[2], 10);
  return null;
}
/** 行の中の金額を全部（「65,000円 10,000円」→ [65000, 10000]） */
export function yenAll(t: string | null | undefined): number[] {
  const s = toHalf(String(t ?? "")).replace(/,/g, "");
  const out: number[] = [];
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*万\s*円?|¥\s*(\d+)|(\d+)\s*円/g)) {
    out.push(m[1] != null ? Math.round(parseFloat(m[1]) * 10000) : parseInt(m[2] ?? m[3], 10));
  }
  return out;
}
/** 敷礼の値: 「なし」「－」「0」→ 0 / 「1ヶ月」→ 1 / 金額 → { yen } / 読めない → null */
function depositValue(v: string): { months: number | null; yen: number | null } | null {
  const s = toHalf(v).trim();
  if (/^(なし|無し|無|-|ー|0|0円|0ヶ月)$/.test(s)) return { months: 0, yen: null };
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[ヶかカケヵ]?\s*月/);
  if (m) return { months: parseFloat(m[1]), yen: null };
  const y = yenOf(s);
  if (y != null) return { months: null, yen: y };
  return null;
}

// ─── 設備の語 ────────────────────────────────────────────────────────────────

/** 設備の語（ラベル・見つける正規表現）。説明文・資料・🌟の本文の三方で同じ物を使う */
export const EQUIPMENT_WORDS: Array<[string, RegExp]> = [
  ["オートロック", /オートロック/],
  ["宅配ボックス", /宅配(?:ボックス|BOX|box|ＢＯＸ)/],
  ["バス・トイレ別", /(?:バス|風呂|浴室)[・･\s]?(?:トイレ)?別|バストイレ別|B・T別|BT別/],
  ["独立洗面台", /独立洗面|洗面(?:所)?独立|シャンプードレッサー/],
  ["室内洗濯機置場", /室内洗濯機|洗濯機置場\s*[（(]?室内/],
  ["エレベーター", /エレベーター/],
  ["追い焚き", /追(?:い)?焚|追炊/],
  ["浴室乾燥機", /浴室(?:換気)?乾燥/],
  ["システムキッチン", /システムキッチン/],
  ["対面キッチン", /対面(?:式)?キッチン|カウンターキッチン/],
  ["2口コンロ", /(?:2|二)口(?:以上の)?(?:ガス|IH)?コンロ/],
  ["エアコン", /エアコン|冷暖房/],
  ["ネット無料", /(?:インター)?ネット(?:使用料)?無料|Wi-?Fi無料|WiFi無料/i],
  ["角部屋", /角部屋/],
  ["南向き", /南向き|南面/],
  ["ペット相談", /ペット(?:可|相談|飼育可)/],
  ["駐車場", /駐車場(?:あり|有|空き)/],
  ["駐輪場", /駐輪場/],
  ["ウォークインクローゼット", /ウォークイン|WIC|W\.I\.C/],
  ["温水洗浄便座", /温水洗浄便座|ウォシュレット|シャワートイレ/],
  ["24時間ゴミ出し", /24時間ゴミ|ゴミ出し24時間/],
  ["フローリング", /フローリング/],
  ["家具家電付き", /家具(?:・)?家電付/],
  ["スマートロック", /スマートロック/],
  ["モニター付インターホン", /モニター付(?:き)?インターホン|TVモニタ/],
  ["分譲賃貸", /分譲/],
  ["最上階", /最上階/],
];
export function equipmentWords(text: string | null | undefined): string[] {
  const s = toHalf(String(text ?? ""));
  const out: string[] = [];
  for (const [label, re] of EQUIPMENT_WORDS) if (re.test(s)) out.push(label);
  return out;
}

// ─── 文字から事実を読む ──────────────────────────────────────────────────────

const PLAN_RE = /(?:^|[^0-9A-Za-z])([1-9])\s*(S?LDK|S?DK|S?K|R)(?![A-Za-z])/;
function planOf(s: string): string | null {
  const h = toHalf(s);
  if (/ワンルーム/.test(h)) return "1R";
  const m = h.match(PLAN_RE);
  return m ? `${m[1]}${m[2].toUpperCase()}` : null;
}

/** 駅と徒歩（全部）。「JR京都線 新大阪駅 徒歩8分」「阪急京都本線「十三」徒歩4分」「なんば駅 徒歩5分」 */
export function parseStations(text: string | null | undefined): Station[] {
  const s = toHalf(String(text ?? ""));
  const out: Station[] = [];
  const seen = new Set<string>();
  const re = /(?:([^\s「」『』\n/、,:。！!？?（）()]{1,24}?線)\s*)?[「『]?([^\s「」『』\n/、,:0-9。！!？?（）()]{1,14}?)[」』]?\s*駅?\s*(?:より|から|まで)?\s*(?:徒歩|歩)\s*(\d{1,2})\s*分/g;
  for (const m of s.matchAll(re)) {
    let station = m[2].replace(/駅$/, "").replace(/^(?:沿線|交通|最寄(?:り)?駅?)[:：]?/, "").trim();
    if (!station || /^(バス|停|停留所)$/.test(station) || /バス停?$/.test(station)) continue;
    const walk = parseInt(m[3], 10);
    const line = m[1] ? m[1].replace(/^(?:沿線|交通)[:：]?/, "").trim() || null : null;
    const k = `${line ?? ""}|${station}|${walk}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ line, station, walk });
  }
  return out;
}

const PREF = "(?:大阪府|兵庫県|京都府|奈良県|滋賀県|和歌山県|東京都|北海道|[^\\s\\d]{2,3}県)";
/** 所在地（「大阪府大阪市淀川区西宮原1丁目7-46」「所在地: 大阪市浪速区…」）。名前の行を拾わないよう、府県・「所在地/住所」・「〇〇市〇〇区」のどれかが要る */
export function parseAddress(text: string | null | undefined): string | null {
  const s = toHalf(String(text ?? ""));
  const lab = s.match(/(?:所在地|住所)\s*[:：]?\s*([^\n/]{3,50})/);
  if (lab && /[市区町村]/.test(lab[1])) return lab[1].trim().slice(0, 50);
  const pref = s.match(new RegExp(`${PREF}[^\\s\\n/、,]{2,40}`));
  if (pref && /[市区町村郡]/.test(pref[0])) return pref[0].trim().slice(0, 50);
  const city = s.match(/[^\s\n/、,]{1,5}市[^\s\n/、,]{1,5}区[^\s\n/、,]{0,30}/);
  return city ? city[0].trim().slice(0, 50) : null;
}
/** 所在地 → 区（政令市）か市 */
export function wardOf(address: string | null | undefined): string | null {
  const a = toHalf(String(address ?? "")).replace(new RegExp(`^${PREF}`), "");
  const ku = a.match(/市([^\s市]{1,5}?区)/);
  if (ku) return ku[1];
  const tokyo = a.match(/^([^\s市]{1,5}?区)/);
  if (tokyo) return tokyo[1];
  const shi = a.match(/^([^\s]{1,6}?市)/);
  return shi ? shi[1] : null;
}

/** 築年月（「築年月 2019年3月」「/ 2008年6月」「2015年2月築」）。入居日（2026年10月1日）を拾わないよう、築の言葉か itandi の「/ 年月」の形だけ */
export function parseBuilt(text: string | null | undefined): { ym: string | null; age: number | null } {
  const s = toHalf(String(text ?? ""));
  const pats = [
    /(?:築年月|築年|建築年月|竣工|完成|築)\s*[:：]?\s*((?:19|20)\d{2})\s*年\s*(\d{1,2})?\s*月?/,
    /((?:19|20)\d{2})\s*年\s*(?:(\d{1,2})\s*月)?\s*(?:築|建築|竣工|完成)/,
    /^\s*\/\s*((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*$/m,
    /((?:19|20)\d{2})\/(\d{1,2})\s*築/,
    /築年月?\s*[:：]?\s*((?:19|20)\d{2})\/(\d{1,2})/,
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (m) {
      const y = parseInt(m[1], 10);
      const mo = m[2] ? parseInt(m[2], 10) : null;
      if (mo != null && (mo < 1 || mo > 12)) continue;
      return { ym: mo ? `${y}-${String(mo).padStart(2, "0")}` : String(y), age: null };
    }
  }
  const age = s.match(/築\s*(\d{1,2})\s*年/);
  if (age) return { ym: null, age: parseInt(age[1], 10) };
  if (/新築/.test(s)) return { ym: null, age: 0 };
  return { ym: null, age: null };
}
/** 築年月 → 築年数（基準日との差・切り捨て） */
export function ageFromBuiltYm(ym: string | null | undefined, now: Date | string = new Date()): number | null {
  const m = String(ym ?? "").match(/^(\d{4})(?:-(\d{2}))?$/);
  if (!m) return null;
  const d = typeof now === "string" ? new Date(now) : now;
  const months = (d.getUTCFullYear() - parseInt(m[1], 10)) * 12 + (d.getUTCMonth() + 1 - (m[2] ? parseInt(m[2], 10) : 1));
  return months < 0 ? 0 : Math.floor(months / 12);
}

export type ParsedFacts = Partial<Pick<CandidateFacts,
  "rent" | "admin_fee_yen" | "deposit_months" | "key_money_months" | "deposit_yen" | "key_money_yen" | "floor_plan" | "area_sqm" |
  "built_ym" | "building_age" | "stations" | "address" | "floor" | "total_floors" | "room_no" | "ad_months" | "ad_yen" | "equipment">>;

/**
 * 1件の生の文字（拡張の説明文・行のセル・建物の段・資料の文字層）から読めるだけ読む。
 * 読めない項目は入れない（null を入れて上書きしない）。
 */
export function parseFactsFromText(text: string | null | undefined): ParsedFacts {
  const raw = toHalf(String(text ?? ""));
  if (!raw.trim()) return {};
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const body = lines.filter((l) => !/^【\s*\d+/.test(l)); // 説明文の1行目（【N】物件名）は名前なので読まない
  const bodyText = body.join("\n");
  const out: ParsedFacts = {};

  // 家賃・管理費: 「65,000円 10,000円」「賃料: 5.7万円」「家賃77,000円・管理費3,000円」
  const rentLab = bodyText.replace(/,/g, "").match(/(?:賃料|家賃)\s*[:：]?\s*(\d+(?:\.\d+)?\s*万\s*円?|\d+\s*円)/);
  const admLab = bodyText.replace(/,/g, "").match(/(?:管理費|共益費)(?:[・･]?共益費)?\s*[:：]?\s*(\d+\s*円|なし|無し|-|ー)/);
  if (rentLab) { const v = yenOf(rentLab[1]); if (v != null && v >= 15000 && v <= 1_000_000) out.rent = v; }
  if (admLab) out.admin_fee_yen = /\d/.test(admLab[1]) ? yenOf(admLab[1]) : 0;
  if (out.rent == null) {
    for (const l of body) {
      if (/(?:AD|広告|敷|礼|保証|更新|割引|初期費用)/i.test(l)) continue;
      const a = yenAll(l);
      if (a.length && a[0] >= 15000 && a[0] <= 1_000_000) {
        out.rent = a[0];
        if (out.admin_fee_yen == null && a.length >= 2 && a[1] < a[0] && a[1] <= 100_000) out.admin_fee_yen = a[1];
        break;
      }
    }
  }

  // 敷金・礼金: 「敷1ヶ月 礼なし」「敷金 なし 礼金 1ヶ月」「敷金礼金なし」「敷礼0」
  if (/敷金?[・･]?礼金?(?:共に|とも|ともに)?\s*(?:なし|無し|0円?|ゼロ)|礼金?[・･]?敷金?\s*(?:なし|無し|0円?|ゼロ)|敷礼\s*(?:なし|0|ゼロ)/.test(bodyText)) {
    out.deposit_months = 0; out.key_money_months = 0;
  } else {
    const VAL = "(なし|無し|無|-|ー|0|\\d+(?:\\.\\d+)?\\s*[ヶかカケヵ]?\\s*月|[\\d,.]+\\s*万?\\s*円)";
    const dep = bodyText.match(new RegExp(`敷(?:金)?\\s*[:：]?\\s*${VAL}`));
    const key = bodyText.match(new RegExp(`礼(?:金)?\\s*[:：]?\\s*${VAL}`));
    const dv = dep ? depositValue(dep[1]) : null;
    const kv = key ? depositValue(key[1]) : null;
    if (dv) { if (dv.months != null) out.deposit_months = dv.months; if (dv.yen != null) out.deposit_yen = dv.yen; }
    if (kv) { if (kv.months != null) out.key_money_months = kv.months; if (kv.yen != null) out.key_money_yen = kv.yen; }
  }

  // 間取り・広さ
  for (const l of body) {
    if (/(?:AD|広告|敷|礼)/i.test(l)) continue;
    const p = planOf(l);
    if (p) { out.floor_plan = p; break; }
  }
  const sq = bodyText.match(/(\d{1,3}(?:\.\d{1,2})?)\s*(?:㎡|m2|m²|平米)/i);
  if (sq) { const v = parseFloat(sq[1]); if (v >= 5 && v <= 500) out.area_sqm = v; }

  // 築年
  const built = parseBuilt(bodyText);
  if (built.ym) out.built_ym = built.ym;
  if (built.age != null) out.building_age = built.age;

  // 駅・徒歩
  const st = parseStations(bodyText);
  if (st.length) out.stations = st;

  // 所在地
  const addr = parseAddress(bodyText);
  if (addr) out.address = addr;

  // 階・階建・号室
  const tf = bodyText.match(/(\d{1,2})\s*階建/);
  if (tf) out.total_floors = parseInt(tf[1], 10);
  const fl = bodyText.match(/(?:所在階\s*[:：]?\s*(\d{1,2})\s*階?|(\d{1,2})\s*階部分|(\d{1,2})\s*階\s*\/\s*\d{1,2}\s*階建)/);
  if (fl) out.floor = parseInt(fl[1] ?? fl[2] ?? fl[3], 10);
  const rm = bodyText.match(/(?:^|[\s/])([A-Za-z]?-?\d{2,4})\s*号室/m) ?? bodyText.match(/部屋番号\s*[:：]?\s*([A-Za-z]?-?\d{2,4})/);
  if (rm) out.room_no = rm[1].replace(/^0+(?=\d)/, "");

  // AD
  const adLine = body.find((l) => /(?:^|\s)(?:AD|ＡＤ|広告料|広告費)/i.test(l));
  if (adLine) {
    const a = toHalf(adLine).replace(/,/g, "");
    const m = a.match(/(?:AD|広告料|広告費)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*[ヶかカケヵ]?\s*月/i);
    const p = a.match(/(?:AD|広告料|広告費)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i);
    const y = a.match(/(?:AD|広告料|広告費)\s*[:：]?\s*(\d+)\s*円/i);
    if (m && parseFloat(m[1]) <= 12) out.ad_months = parseFloat(m[1]);
    else if (p) out.ad_months = parseFloat(p[1]) / 100;
    else if (y) out.ad_yen = parseInt(y[1], 10);
  }

  const eq = equipmentWords(bodyText);
  if (eq.length) out.equipment = eq;
  return out;
}

// ─── 送った画像の読み取り → 候補の値 ─────────────────────────────────────────

/** property-image-read の ReadItem と同じ形（import しない＝この純関数を画面・拡張のテストからも使える） */
export type ImageReadItemLike = {
  propertyName?: string | null; roomNumber?: string | null; rent?: number | null; adminFee?: number | null; deposit?: number | null; keyMoney?: number | null;
  floorPlan?: string | null; areaSqm?: number | null; station?: string | null; walkMinutes?: number | null; built?: string | null; ad?: string | null;
  status?: string | null; vacancyDate?: string | null;
};
export type ImageFacts = ParsedFacts & { station?: string | null; walk_minutes?: number | null; status?: string | null; vacancy_date?: string | null; read_items?: number };

/**
 * 2026-09-25 竹内「候補の記憶を太くする」: お客様に送った画像1枚の読み取り（DeepSeek）→ 候補の値（sent_image_properties.facts）。
 *   ・敷金・礼金は「月数で書いてあれば月数の数字」と頼んでいるので、12 以下は月数・それより大きければ円
 *   ・範囲外（家賃 1.5万未満・100万超、㎡ 5未満・500超、徒歩 60分超）は捨てる（誤読をそのまま残さない）
 *   ・読めなかった項目は入れない（0 に丸めない）
 */
export function factsFromImageRead(item: ImageReadItemLike, now: Date | string = new Date()): ImageFacts {
  const out: ImageFacts = {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const rent = n(item.rent);
  if (rent != null && rent >= 15000 && rent <= 1_000_000) out.rent = rent;
  const adm = n(item.adminFee);
  if (adm != null && adm >= 0 && adm <= 100_000) out.admin_fee_yen = adm;
  const dk = (v: unknown, m: "deposit" | "key_money") => {
    const x = n(v);
    if (x == null || x < 0) return;
    if (x <= 12) out[`${m}_months`] = x; else out[`${m}_yen`] = x;
  };
  dk(item.deposit, "deposit");
  dk(item.keyMoney, "key_money");
  const plan = item.floorPlan ? planOf(String(item.floorPlan)) : null;
  if (plan) out.floor_plan = plan;
  const sq = n(item.areaSqm);
  if (sq != null && sq >= 5 && sq <= 500) out.area_sqm = sq;
  const walk = n(item.walkMinutes);
  const st = String(item.station ?? "").replace(/駅$/, "").trim();
  if (st && walk != null && walk >= 0 && walk <= 60) { out.stations = [{ line: null, station: st, walk }]; out.station = st; out.walk_minutes = walk; }
  const b = toHalf(String(item.built ?? ""));
  const bm = b.match(/((?:19|20)\d{2})\s*年\s*(?:(\d{1,2})\s*月)?/) ?? b.match(/((?:19|20)\d{2})\/(\d{1,2})/);
  if (bm) {
    const mo = bm[2] ? parseInt(bm[2], 10) : null;
    out.built_ym = mo && mo >= 1 && mo <= 12 ? `${bm[1]}-${String(mo).padStart(2, "0")}` : bm[1];
    const age = ageFromBuiltYm(out.built_ym, now);
    if (age != null) out.building_age = age;
  } else if (/新築/.test(b)) out.building_age = 0;
  const ad = toHalf(String(item.ad ?? "")).replace(/,/g, "");
  const ap = ad.match(/(\d+(?:\.\d+)?)\s*%/), am = ad.match(/(\d+(?:\.\d+)?)\s*[ヶかカケヵ]?\s*月/), ay = ad.match(/(\d+)\s*円/);
  if (ap) out.ad_months = parseFloat(ap[1]) / 100;
  else if (am && parseFloat(am[1]) <= 12) out.ad_months = parseFloat(am[1]);
  else if (ay) out.ad_yen = parseInt(ay[1], 10);
  const room = String(item.roomNumber ?? "").trim();
  if (room) { out.room_no = room.replace(/号室?$/, ""); const f = floorFromRoomNo(out.room_no); if (f != null) out.floor = f; }
  if (item.status) out.status = item.status;
  if (item.vacancyDate) out.vacancy_date = item.vacancyDate;
  return out;
}

// ─── 1件を太くする ───────────────────────────────────────────────────────────

/** 項目が空か（null・undefined・空配列） */
function empty(v: unknown): boolean { return v == null || (Array.isArray(v) && v.length === 0) || v === ""; }

/**
 * target の空いている項目だけを source で埋める（既に値がある項目は触らない）。設備は和集合。
 * 埋めた項目の出どころを src に書く。埋めた項目名を返す
 */
export function fillMissing(target: CandidateFacts, source: ParsedFacts | Partial<CandidateFacts> | null | undefined, tag: string): string[] {
  if (!source) return [];
  const filled: string[] = [];
  const src = (target.src ??= {});
  for (const [k, v] of Object.entries(source)) {
    if (empty(v) || k === "src" || k === "facts_v") continue;
    if (k === "equipment" && Array.isArray(v)) {
      const cur = Array.isArray(target.equipment) ? target.equipment : [];
      const add = (v as string[]).filter((x) => !cur.includes(x));
      if (add.length) { target.equipment = [...cur, ...add]; src.equipment = src.equipment ? `${src.equipment}+${tag}` : tag; filled.push(k); }
      continue;
    }
    if (!empty(target[k])) continue;
    target[k] = v;
    src[k] = tag;
    filled.push(k);
  }
  return filled;
}

/** 駅の文字列の配列（拡張の itandi の「JR京都線 新大阪駅 徒歩8分」）→ Station[] */
function normalizeStations(v: unknown): Station[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  const out: Station[] = [];
  for (const x of v) {
    if (typeof x === "string") out.push(...parseStations(x));
    else if (x && typeof x === "object" && typeof (x as Station).station === "string" && num((x as Station).walk) != null) out.push({ line: (x as Station).line ?? null, station: (x as Station).station, walk: (x as Station).walk });
  }
  return out.length ? out : null;
}

/** 導ける項目（最寄り・徒歩・区・階・築年数）を埋める */
export function deriveFacts(c: CandidateFacts, now: Date | string = new Date()): void {
  const src = (c.src ??= {});
  if (c.stations && c.stations.length) {
    const best = [...c.stations].sort((a, b) => a.walk - b.walk)[0];
    if (empty(c.station)) { c.station = best.station; src.station = src.stations ?? "derived"; }
    if (c.walk_minutes == null) { c.walk_minutes = best.walk; src.walk_minutes = src.stations ?? "derived"; }
  }
  if (empty(c.ward) && c.address) { const w = wardOf(c.address); if (w) { c.ward = w; src.ward = src.address ?? "derived"; } }
  if (empty(c.room_no) && c.name) { const r = roomFromName(c.name); if (r) { c.room_no = r; src.room_no = "name"; } }
  if (c.floor == null && c.room_no) { const f = floorFromRoomNo(c.room_no); if (f != null) { c.floor = f; src.floor = "room_no"; } }
  if (c.building_age == null && c.built_ym) { const a = ageFromBuiltYm(c.built_ym, now); if (a != null) { c.building_age = a; src.building_age = src.built_ym ?? "derived"; } }
}

/**
 * 拡張から届いた候補1件を太くする（log-property-candidates と埋め戻しで同じ関数）。
 *   ① 拡張が付けた値（ext）をそのまま残す ② 管理費＝家賃（リアプロの「賃料/管理費」が1列の時の読み違い・実測 861/861件）は捨てて読み直す
 *   ③ 生の文字（summary → bld_text → cells → row_text）から空いている項目を埋める ④ 導ける項目を埋める
 */
export function enrichCandidate(raw: Record<string, unknown>, opts: { now?: Date | string } = {}): CandidateFacts {
  const c: CandidateFacts = { ...(raw as CandidateFacts) };
  const src: Record<string, string> = { ...((raw.src as Record<string, string>) ?? {}) };
  c.src = src;
  for (const k of Object.keys(c)) {
    if (["src", "facts_v", "cells", "head", "bld_text", "row_text", "summary", "read_mode"].includes(k)) continue;
    if (!empty(c[k]) && !src[k]) src[k] = "ext";
  }
  if (c.stations) c.stations = normalizeStations(c.stations);
  // ② 管理費＝家賃は読み違い
  if (num(c.admin_fee_yen) != null && num(c.rent) != null && c.admin_fee_yen === c.rent) {
    c.admin_fee_yen = null;
    delete src.admin_fee_yen;
    src.admin_fee_fix = "eq_rent_dropped";
  }
  // 家賃の範囲外（拡張の読み違い）は捨てる
  if (num(c.rent) != null && ((c.rent as number) < 15000 || (c.rent as number) > 1_000_000)) { c.rent = null; delete src.rent; }
  if (num(c.ad_months) != null && (c.ad_months as number) > 12) { c.ad_months = null; delete src.ad_months; }
  // ③ 生の文字
  const cells = Array.isArray(raw.cells) ? (raw.cells as unknown[]).map((x) => String(x ?? "")).filter(Boolean) : [];
  const texts: Array<[string, string]> = [
    ["summary", String(raw.summary ?? "")],
    ["bld_text", String(raw.bld_text ?? "")],
    ["cells", cells.join("\n")],
    ["row_text", String(raw.row_text ?? "")],
  ];
  for (const [tag, t] of texts) if (t.trim()) fillMissing(c, parseFactsFromText(t), `text:${tag}`);
  // ④
  deriveFacts(c, opts.now ?? new Date());
  c.facts_v = FACTS_VERSION;
  return c;
}

/** 保存用に生の文字を切り詰める（1件が大きくなりすぎないように: セル40個×120字・建物の段600字） */
export function clipRawForStorage(c: CandidateFacts): CandidateFacts {
  const out: CandidateFacts = { ...c };
  if (Array.isArray(out.cells)) out.cells = (out.cells as unknown[]).slice(0, 40).map((x) => String(x ?? "").slice(0, 120));
  if (Array.isArray(out.head)) out.head = (out.head as unknown[]).slice(0, 40).map((x) => String(x ?? "").slice(0, 30));
  for (const k of ["bld_text", "row_text"]) if (typeof out[k] === "string") out[k] = (out[k] as string).slice(0, 600);
  if (typeof out.summary === "string") out.summary = (out.summary as string).slice(0, 600);
  return out;
}

/** 項目が分かっているか（監査・カバー率の数え方） */
export function hasField(c: CandidateFacts, f: FactField): boolean {
  if (f === "ad_months_or_yen") return num(c.ad_months) != null || num(c.ad_yen) != null;
  if (f === "equipment") return Array.isArray(c.equipment) && c.equipment.length > 0;
  return !empty(c[f]);
}
/** 項目ごとの分かっている率 */
export function coverageOf(cands: CandidateFacts[]): Record<FactField, number> {
  const out = {} as Record<FactField, number>;
  for (const f of FACT_FIELDS) out[f] = cands.length ? cands.filter((c) => hasField(c, f)).length / cands.length : 0;
  return out;
}
