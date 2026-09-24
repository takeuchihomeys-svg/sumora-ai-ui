// app/lib/listing-text.ts（純関数・依存なし・画面とサーバーで共用できる）
// 物件資料の PDF の文字層（pdf-text の text）から、LINE の説明文に要る事実を取り出し、説明文の抜けを補う。
//
// 2026-09-24 竹内「賃料と間取りも㎡数取り入れるようにする。そうじゃないとちゃんと判断できないので」
//   「駅名や徒歩数もリアプロ itandi ともに読み取れているのか」
//
// 実態（2026-09-24 夜・property_pickups id 34〜45 リアプロ／50〜67 itandi の PDF を読み直して確かめた）:
//   - itandi の説明文は拡張ツール（itandi-bulk-dl.js）が「【n】名前」と「AD」しか作らず、名前も一覧の DOM から取れず全件「物件」。
//     賃料・間取り・㎡・駅・徒歩は一切入っていなかった（LINE グループが「【1】物件 AD 1ヶ月」・順位付けも一致確認も材料なし）
//   - リアプロの説明文は「名前／賃料 管理費／間取り ㎡／AD」で、号室・駅名・徒歩分数が無い（sent_properties の徒歩は 0%）
//   - 一方 PDF の文字層にはどちらも 物件名・号室・賃料・管理費・間取り・専有面積・交通（複数行）がある（30/30 件）
//     リアプロ: 「物件名 X」「号室名 0403（4階部分）」「間取タイプ 1K[洋室7帖]」「専有面積 25.62㎡」「賃料\n75,000 円」「共益費・管理費 10,000円」
//               交通は「堺筋線「恵美須町」徒歩5分」
//     itandi:   1ページ目の上の帯「エステムコート新⼤阪 Ⅵ エキスプレイス 405 号室」（字の間に空白・康熙部首の字 ⼤＝U+2F24 が混ざる → NFKC）
//               「賃料 67,000 円 管理費‧共益費 なし」「間取り 1K 専有⾯積 20.8 ㎡」（㎡ は NFKC で m2）
//               交通は「JR 京都線 新⼤阪駅 徒歩 8 分」
// 決まり:
//   - 説明文にある値が正（拡張が表から取った値）。無い所だけ文字層で補う。食い違いは補わずに返す（呼ぶ側でログ）
//   - 説明文の物件名が使える名前で、文字層の物件名と違う → その PDF は別の物件（組の取り違え）とみなし、何も補わない
//   - 交通は全行を持ち、最短の徒歩（バスの行は除く）を説明文に1行だけ足す（LINE が長くならないように）

export type AccessLine = {
  /** 行の文（空白を詰めた物） */
  text: string;
  /** 路線（分かる時だけ） */
  line: string | null;
  /** 駅名（「駅」を付けない） */
  station: string | null;
  /** 徒歩分数（バスの行は停留所からの徒歩） */
  walk: number | null;
  /** バスを使う行 */
  bus: boolean;
};

export type ListingFacts = {
  /** どちらの資料の形で読めたか */
  format: "realpro" | "itandi" | "unknown";
  name: string | null;
  /** 号室（数字だけ・先頭の 0 を外す）。「3A」等の数字でない号室は roomLabel にだけ入る */
  roomNo: string | null;
  roomLabel: string | null;
  rentYen: number | null;
  /** 管理費・共益費（「なし」は 0） */
  adminFeeYen: number | null;
  madori: string | null;
  areaSqm: number | null;
  access: AccessLine[];
  /** 最短の徒歩（バスの行を除く） */
  nearest: AccessLine | null;
};

const EMPTY: ListingFacts = { format: "unknown", name: null, roomNo: null, roomLabel: null, rentYen: null, adminFeeYen: null, madori: null, areaSqm: null, access: [], nearest: null };

/**
 * CJK 部首補助（U+2E80〜）の字は NFKC で直らない（itandi の文字層の「⻄中島南方」の ⻄＝U+2EC4 が実物で出た）→ よく出る字だけ置き換える
 */
const RADICAL_SUPPLEMENT: Record<string, string> = {
  "⻄": "西", "⻑": "長", "⻘": "青", "⻝": "食", "⻤": "鬼", "⻩": "黄", "⻫": "斉", "⻭": "歯",
  "⻯": "竜", "⻲": "亀", "⻨": "麦",
};
/** 文字層の揺れを揃える（康熙部首・全角・㎡→m2 は NFKC、部首補助は表で、「‧」「･」は「・」） */
export function normalizeListingText(raw: string | null | undefined): string {
  return String(raw ?? "").normalize("NFKC").replace(/[⺀-⻿]/g, (c) => RADICAL_SUPPLEMENT[c] ?? c).replace(/[‧･]/g, "・").replace(/[ \t]+/g, " ");
}

/** CJK・かなの隣の空白を詰める（「エステムコート新大阪 VI エキスプレイス」→「エステムコート新大阪VIエキスプレイス」）。英字どうしの空白は残す */
export function squeezeJaSpaces(s: string): string {
  const ja = "\\u3040-\\u30ff\\u3400-\\u9fff\\uff66-\\uff9f々〆ー";
  return s.replace(new RegExp(`([${ja}])\\s+`, "g"), "$1").replace(new RegExp(`\\s+([${ja}])`, "g"), "$1").replace(/\s{2,}/g, " ").trim();
}

const toInt = (s: string) => parseInt(s.replace(/[,，\s]/g, ""), 10);
const yen = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = toInt(s);
  return Number.isFinite(n) ? n : null;
};

function normMadori(s: string | null | undefined): string | null {
  const t = String(s ?? "").toUpperCase().replace(/\s/g, "").replace(/ワンルーム/, "1R");
  const m = t.match(/^([1-9])(S?LDK|S?DK|SK|K|R)/);
  if (!m) return null;
  return `${m[1]}${m[2].replace(/^S(?=L?D?K)/, "")}`;
}

/** 交通の1行を読む（「堺筋線「恵美須町」徒歩5分」「JR京都線 新大阪駅 徒歩 8 分」「バス10分「〇〇」停歩3分」） */
export function parseAccessLine(raw: string): AccessLine | null {
  const text = squeezeJaSpaces(raw);
  const walkM = text.match(/(?:徒歩|停歩|歩)\s*(\d{1,3})\s*分/);
  if (!walkM && !/駅|「/.test(text)) return null;
  const bus = /バス|停歩|バス停/.test(text);
  let line: string | null = null, station: string | null = null;
  const q = text.match(/^(.*?)「([^」]+)」/);
  if (q) { line = q[1].trim() || null; station = q[2].trim(); }
  else {
    const s = text.match(/^(.*?)\s*([^\s]+?)駅/);
    if (s) {
      // 「JR京都線新大阪」→ 路線は「線」まで
      const joined = `${s[1]}${s[2]}`.replace(/\s/g, "");
      const lm = joined.match(/^(.*?(?:線|ライン|ライナー|鉄道|電鉄|モノレール))(.+)$/);
      if (lm) { line = lm[1]; station = lm[2]; } else { station = joined; }
    }
  }
  const walk = walkM ? parseInt(walkM[1], 10) : null;
  return { text, line, station, walk: walk != null && walk > 0 && walk <= 90 ? walk : null, bus };
}

/** 交通の欄（「交通」の見出しの次の行から、次の項目の見出しまで） */
function accessBlock(lines: string[]): string[] {
  const i = lines.findIndex((l) => /^交通\s*$/.test(l.trim()) || /^交通\s+\S/.test(l.trim()));
  if (i < 0) return [];
  const out: string[] = [];
  const first = lines[i].trim().replace(/^交通\s*/, "");
  if (first) out.push(first);
  for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
    const l = lines[j].trim();
    if (!l) continue;
    if (/^(賃料|建築構造|建物構造|間取|所在地|専有面積|物件種目|構造|築年|MAP)/.test(l)) break;
    if (!/徒歩|停歩|駅|「|バス/.test(l)) break;
    out.push(l);
  }
  return out;
}

/**
 * 資料の文字層から事実を取る。複数ページ（弊社の帯の1ページ目＋元付の2ページ目）でも、最初に出てくる値を採る。
 * 文字が少ない・形が分からない時は format="unknown" で、取れた物だけ返す。
 */
export function parseListingText(raw: string | null | undefined): ListingFacts {
  const text = normalizeListingText(raw);
  if (text.trim().length < 40) return { ...EMPTY };
  const lines = text.split("\n").map((l) => l.trim());
  const isRealpro = /物件名\s+\S/.test(text) && /(号室名|間取タイプ|RealNetPro)/i.test(text);
  const out: ListingFacts = { ...EMPTY, access: [] };
  if (isRealpro) {
    out.format = "realpro";
    const nameM = text.match(/物件名[ \t]+([^\n]+)/);
    out.name = nameM ? squeezeJaSpaces(nameM[1]) : null;
    const roomM = text.match(/号室名[ \t]+([^\n（(]+)/);
    const roomRaw = roomM ? roomM[1].trim() : "";
    if (roomRaw) {
      out.roomLabel = roomRaw.replace(/号室$/, "");
      const d = roomRaw.match(/^0*(\d{1,5})(?:号室?)?$/);
      out.roomNo = d ? d[1] : null;
    }
    out.madori = normMadori((text.match(/間取タイプ[ \t]+([^\n]+)/) ?? [])[1]);
    const area = text.match(/専有面積[ \t]+(\d+(?:\.\d+)?)\s*(?:m2|平米)/i);
    out.areaSqm = area ? parseFloat(area[1]) : null;
    out.rentYen = yen((text.match(/賃料[ \t]*\n?[ \t]*([\d,]+)\s*円/) ?? [])[1]);
    const adm = text.match(/(?:共益費・管理費|管理費・共益費|管理費|共益費)[ \t]*\n?[ \t]*(なし|無し|-|ー|[\d,]+\s*円)/);
    out.adminFeeYen = adm ? (/^[\d,]/.test(adm[1]) ? yen(adm[1]) : 0) : null;
  } else {
    // itandi: 上の帯「〇〇 405 号室」（1ページ目の最初に出る「号室」で終わる行）
    const band = lines.find((l) => /\S\s*号室\s*$/.test(l) && !/^(号室|部屋番号)/.test(l));
    const isItandi = !!band || /間取り\s+\S+\s+専有面積/.test(text) || /主要採光面|入居可能時期|敷引償却/.test(text);
    out.format = isItandi ? "itandi" : "unknown";
    if (band) {
      const m = band.match(/^(.*?)\s+([0-9A-Za-z\-－]+|複数あり)\s*号室\s*$/);
      if (m) {
        out.name = squeezeJaSpaces(m[1]) || null;
        const r = m[2];
        out.roomLabel = r === "複数あり" ? null : r;
        out.roomNo = /^\d{1,5}$/.test(r) ? String(parseInt(r, 10)) : null;
      } else {
        out.name = squeezeJaSpaces(band.replace(/\s*号室\s*$/, "")) || null;
      }
    }
    out.rentYen = yen((text.match(/賃料[ \t]*\n?[ \t]*([\d,]+)\s*円/) ?? [])[1]);
    const adm = text.match(/(?:管理費・共益費|共益費・管理費|管理費|共益費)[ \t]*\n?[ \t]*(なし|無し|-|ー|[\d,]+\s*円)/);
    out.adminFeeYen = adm ? (/^[\d,]/.test(adm[1]) ? yen(adm[1]) : 0) : null;
    out.madori = normMadori((text.match(/間取り?[ \t]+([1-9][^\s]*)/) ?? [])[1]);
    const area = text.match(/専有面積[ \t]*(\d+(?:\.\d+)?)\s*(?:m2|平米)/i);
    out.areaSqm = area ? parseFloat(area[1]) : null;
  }
  // 家賃の妥当な範囲（読み違いを捨てる）
  if (out.rentYen != null && (out.rentYen < 10_000 || out.rentYen > 2_000_000)) out.rentYen = null;
  if (out.adminFeeYen != null && (out.adminFeeYen < 0 || out.adminFeeYen > 200_000)) out.adminFeeYen = null;
  if (out.areaSqm != null && (out.areaSqm < 5 || out.areaSqm > 500)) out.areaSqm = null;
  out.access = accessBlock(lines).map(parseAccessLine).filter((a): a is AccessLine => !!a);
  const walks = out.access.filter((a) => !a.bus && a.walk != null && a.station);
  out.nearest = walks.length ? walks.reduce((a, b) => ((b.walk as number) < (a.walk as number) ? b : a)) : null;
  return out;
}

// ── 説明文を補う ────────────────────────────────────────────────────────

const SUMMARY_NO_RE = /^【\d+(?:🌟★?)?】/u;
const toHalf = (s: string) => s.normalize("NFKC");

/** 説明文から、補うかどうかを決める材料（どの行があるか） */
function summaryHas(summary: string): { name: string; room: boolean; rent: boolean; madori: boolean; area: boolean; walk: boolean; rentYen: number | null; areaSqm: number | null; madoriTok: string | null } {
  const lines = String(summary ?? "").split("\n");
  const head = (lines[0] ?? "").replace(SUMMARY_NO_RE, "").trim();
  const rest = lines.slice(1).map(toHalf);
  const room = /[\s　]\d{1,5}(?:号室?)?$/.test(toHalf(head)) || /号室/.test(head);
  const name = head.replace(/[\s　]+\d{1,5}(?:号室?)?$/, "").trim();
  let rentYen: number | null = null, areaSqm: number | null = null, madoriTok: string | null = null;
  for (const l of rest) {
    if (/^(AD|広告)/i.test(l)) continue;
    const t = l.replace(/,/g, "");
    if (rentYen == null) {
      const man = t.match(/(\d+(?:\.\d+)?)\s*万/);
      const y = t.match(/(\d{4,7})\s*円/);
      if (man) rentYen = Math.round(parseFloat(man[1]) * 10000); else if (y) rentYen = parseInt(y[1], 10);
    }
    if (areaSqm == null) { const a = t.match(/(\d+(?:\.\d+)?)\s*(?:㎡|m2|m²|平米)/i); if (a) areaSqm = parseFloat(a[1]); }
    if (madoriTok == null) { const m = t.match(/(?:^|\s)([1-9](?:S?LDK|S?DK|SK|K|R))(?=\s|$|\[|（|\()/i); if (m) madoriTok = normMadori(m[1]); }
  }
  const walk = rest.some((l) => /徒歩\s*\d+\s*分/.test(l));
  return { name, room, rent: rentYen != null, madori: madoriTok != null, area: areaSqm != null, walk, rentYen, areaSqm, madoriTok };
}

/** 名前が一般名（拡張が取れなかった時の「物件」「物件3」）か */
export function isPlaceholderName(name: string | null | undefined): boolean {
  const s = String(name ?? "").trim();
  return !s || /^物件\s*\d*$/.test(s) || s === "不明";
}

/** 名前を比べる形（空白・記号・ローマ数字・大小を揃える） */
function nameKey(s: string): string {
  return toHalf(s).replace(/[\s　・,.\-－ー()（）「」★☆]/g, "").toLowerCase();
}
/** 同じ建物の名前か（片方がもう片方を含めば同じ。拡張が 40 字で切った名前にも当たる） */
export function sameListingName(a: string, b: string): boolean {
  const x = nameKey(a), y = nameKey(b);
  if (!x || !y) return true;
  return x === y || x.includes(y) || y.includes(x);
}

export type SummaryFill = {
  summary: string;
  /** 足した項目（name・room・rent・madori・area・walk） */
  filled: string[];
  /** 説明文と文字層が食い違った項目（補わない・ログ用） */
  conflicts: string[];
  /** 名前が違うので別の物件の PDF と判断し、何もしなかった */
  skipped: boolean;
};

const fmtYen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const fmtArea = (n: number) => `${Number.isInteger(n) ? n : String(n)}㎡`;

/** 交通の1行（説明文に足す形）: 「JR京都線「新大阪」徒歩8分」 */
export function formatAccess(a: AccessLine): string {
  const st = a.station ? `「${a.station.replace(/駅$/, "")}」` : "";
  return `${a.line ?? ""}${st}徒歩${a.walk}分`.trim();
}

/**
 * 説明文の抜けを文字層の事実で補う（説明文にある値は変えない）。
 * 形はリアプロの説明文に揃える:
 *   【n】物件名 405号室
 *   67,000円 管理費5,000円
 *   1K 20.8㎡
 *   JR京都線「新大阪」徒歩8分
 *   AD 1ヶ月
 * 足す行は AD の行の前に入れる（AD は最後の行のまま）。
 */
export function fillSummaryFromListing(summary: string, f: ListingFacts): SummaryFill {
  const res: SummaryFill = { summary, filled: [], conflicts: [], skipped: false };
  if (!summary || (f.format === "unknown" && !f.name && f.rentYen == null)) return res;
  const has = summaryHas(summary);
  const placeholder = isPlaceholderName(has.name);
  if (!placeholder && f.name && !sameListingName(has.name, f.name)) {
    res.skipped = true;
    res.conflicts.push(`name:${has.name}≠${f.name}`);
    return res;
  }
  if (has.rent && f.rentYen != null && has.rentYen !== f.rentYen) res.conflicts.push(`rent:${has.rentYen}≠${f.rentYen}`);
  if (has.area && f.areaSqm != null && has.areaSqm != null && Math.abs(has.areaSqm - f.areaSqm) > 0.1) res.conflicts.push(`area:${has.areaSqm}≠${f.areaSqm}`);
  if (has.madori && f.madori && has.madoriTok !== f.madori) res.conflicts.push(`madori:${has.madoriTok}≠${f.madori}`);

  const lines = summary.split("\n");
  // 1行目: 名前（一般名なら差し替え）＋号室（無ければ）
  const noM = (lines[0] ?? "").match(SUMMARY_NO_RE);
  const no = noM ? noM[0] : "";
  let head = (lines[0] ?? "").slice(no.length).trim();
  if (placeholder && f.name) { head = f.name; res.filled.push("name"); }
  // 反証 2026-09-25: 拡張 v2.5.16 の itandi の説明文（itandi-row-parse.js buildSummary）は号室を1行目でなく「405号室」の独立した行に書く。
  //   1行目に号室が無いと見て文字層の号室を足すと、LINE で号室が2回出る。送付済みの照合（parseSummaryHead）は1行目の号室しか読まない
  //   → 独立した号室の行は1行目へ移す（説明文の値が正・文字層の号室と違えば食い違いとして返す）
  const roomLineIdx = has.room ? -1 : lines.findIndex((l, i) => i > 0 && /^\s*\d{1,5}\s*号室\s*$/.test(toHalf(l)));
  if (roomLineIdx > 0 && (!placeholder || f.name)) {
    const r = String(parseInt(toHalf(lines[roomLineIdx]).replace(/\D/g, ""), 10));
    if (f.roomNo && f.roomNo !== r) res.conflicts.push(`room:${r}≠${f.roomNo}`);
    head = `${head} ${r}号室`;
    lines.splice(roomLineIdx, 1);
    res.filled.push("room_moved");   // 呼ぶ側は filled がある時だけ説明文を差し替える
  } else if (!has.room && f.roomNo && (!placeholder || f.name)) {
    // 号室は名前が分かっている時だけ足す（「物件 405号室」にしない）
    head = `${head} ${f.roomNo}号室`; res.filled.push("room");
  }
  lines[0] = `${no}${head}`;

  const add: string[] = [];
  if (!has.rent && f.rentYen != null) {
    const adm = f.adminFeeYen == null ? "" : f.adminFeeYen === 0 ? " 管理費なし" : ` 管理費${fmtYen(f.adminFeeYen)}`;
    add.push(`${fmtYen(f.rentYen)}${adm}`);
    res.filled.push("rent");
  }
  if (!has.madori || !has.area) {
    const m = !has.madori && f.madori ? f.madori : null;
    const a = !has.area && f.areaSqm != null ? fmtArea(f.areaSqm) : null;
    if (m && a) { add.push(`${m} ${a}`); res.filled.push("madori", "area"); }
    else if (m || a) {
      // 片方だけ無い時は、ある方の行に足す（「1K」の行に㎡を足す）
      const idx = lines.findIndex((l, i) => i > 0 && (m ? /(\d+(?:\.\d+)?)\s*(?:㎡|m2|平米)/.test(toHalf(l)) : /(?:^|\s)[1-9](?:S?LDK|S?DK|SK|K|R)(?=\s|$)/i.test(toHalf(l))));
      if (idx > 0) lines[idx] = m ? `${m} ${lines[idx]}` : `${lines[idx]} ${a}`;
      else add.push((m ?? a) as string);
      res.filled.push(m ? "madori" : "area");
    }
  }
  if (!has.walk && f.nearest && f.nearest.walk != null) { add.push(formatAccess(f.nearest)); res.filled.push("walk"); }
  if (add.length) {
    const adIdx = lines.findIndex((l, i) => i > 0 && /^\s*(AD|ＡＤ|広告)/i.test(l));
    if (adIdx > 0) lines.splice(adIdx, 0, ...add); else lines.push(...add);
  }
  res.summary = lines.join("\n");
  return res;
}
