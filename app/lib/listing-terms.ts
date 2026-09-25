// app/lib/listing-terms.ts（純関数・import なし・fs や DB は使わない）
// 物件資料の PDF の文字層（pdf-text の text）から「募集の条件」を決定論で読む:
//   敷金・礼金・保証金・償却／築年・新築／入居時期（現況）／契約期間（普通・定期）／更新料／フリーレント／
//   入居の条件（楽器・法人・外国籍・学生・事務所・単身・二人入居・ルームシェア・子供）／専有面積
//
// 2026-09-24 竹内「ほかにもれないか」→ 全お客様の条件の監査で「判定の仕組みはあるのに物件側の値が届いていない」漏れが最大と分かった:
//   - 敷礼: property_pickups 36行中33行・property_brain_judgments 43/43 が INITIAL_COST_UNKNOWN（説明文に敷礼が無い）→「敷礼0」の加点が一度も出ていない
//   - 築年: BUILDING_AGE_* の札が本番で0行（文字層の「築年 2019年3月」「築年数 2008年6月」を使っていない）
//   - 入居時期: どこでも照らしていない
//
// 実物（property_pickups の pdf_blob_url 36行・リアプロ 18＋itandi 18 の1ページ目の文字層・2026-09-25 に読み直した）:
//   リアプロ: 「敷金 なし」「礼金 2ヶ月」「礼金 85,000円」「保証金 なし 償却・敷引 なし」「更新料 旧賃料の1ヶ月」「更新料 75,000円」
//            「契約期間 普通借家 2年間」「契約期間 2年間」（種類の無い形がある）「築年 2019年03月」
//            「現況/入居時期 空室 / 即入」「退去予定(10/31) / 相談」「退去予定 / 2026年12月01日」
//            条件は「【条件】 ペット相談・外国人契約可能・2人入居可能・保証会社利用必須」、特記「楽器使用 不可・事務所 不可・飲食店 不可・学生 不可・単身 可」、
//            備考「●ペット飼育可 / 事務所使用不可」「■フリーレント1ヶ月」「■敷金礼金0円」、特記「・法人契約可」「※法人契約相談可(礼金1ヵ月増額)」
//            「・礼金0円の場合でも、法人契約は礼金(総賃料の1ヶ月分)要」
//   itandi:  「敷⾦ / 礼⾦ / 保証⾦ なし / 1 ヶ⽉ / ー 敷引償却 ー」（3つの値が「/」で1行に並ぶ・康熙部首の字）
//            「築年数 2008 年 6 ⽉」「現況 居住中 ⼊居可能時期 2026 年 11 ⽉上旬」「現況 ー ⼊居可能時期 相談」「即⼊居可」「2026 年 10 ⽉ 20 ⽇」
//            「契約期間 2 年間（普通借家）」「契約期間 ー（普通借家）」「契約期間 ー」「更新料 新賃料 1.25 ヶ⽉」「更新料 ー」
//            設備欄の「外国籍可 , ⼆⼈\n⼊居可」（行をまたぐ）「単⾝限定」「事務所使⽤不可」、備考「‧楽器不可‧」「⼤⼿法⼈契約の場合、礼⾦ 1 ヶ⽉積み増し」
//            保証会社欄「※ 外国籍の申込者様は敷⾦ 2 ヶ⽉」（条件付き）・その他費用の「新築物件のみ退去時」（新築の札ではない）
// 決まり:
//   - 「なし／ー／0円」と「書いていない」を分ける（なし・ー＝0、表に行が無い＝null）。更新料の「ー」だけは itandi で空欄の印なので blank（0 とは言わない）
//   - 敷金・礼金は表の行（行頭の「敷金」・itandi の3つ並び）からだけ読む。保証会社欄の「外国籍は敷金2ヶ月」は条件（foreigner＝consult）で、敷金にしない。
//     表が無い時だけ備考の「敷金礼金0円」「敷礼0」を使う（source=備考）
//   - ありえない値は捨てる（敷金・礼金・保証金 6ヶ月超・円が賃料の6倍超・更新料 3ヶ月超・築年が1950年より前か来年より後・面積 5〜500㎡の外）
//   - 条件は ok（可）＞ consult（相談・条件付き）＞ ng（不可）の順に、書いてある時だけ。書いていない＝unlisted（不可とは限らない）
//   - 物件の判定（property-brain）では hold まで・drop には使わない・書いていない時は 0点の要確認（頭の設計は報告と memory に）

// 依存なし（2026-09-25: 未コミットの listing-text.ts に依存していたので、同じ正規化をここに持たせた。
//   listing-equipment.ts の norm・listing-text.ts の normalizeListingText と同じ中身。直す時は3か所を揃える）

// ───────────────────────── 型 ─────────────────────────

export type TermStatus = "ok" | "ng" | "consult" | "unlisted";
export type TermFact = { status: TermStatus; evidence: string | null };
export type ConditionKey = "instrument" | "corporate" | "foreigner" | "student" | "office" | "singleOnly" | "twoPerson" | "roomShare" | "children";

/** 条件の表示名。singleOnly は「単身での入居」の可否（「単身限定」は単身 ok・二人入居 ng・singleOnlyRestricted=true） */
export const CONDITION_LABELS: Record<ConditionKey, string> = {
  instrument: "楽器", corporate: "法人契約", foreigner: "外国籍", student: "学生", office: "事務所使用",
  singleOnly: "単身", twoPerson: "二人入居", roomShare: "ルームシェア", children: "子供",
};
export const CONDITION_KEYS = Object.keys(CONDITION_LABELS) as ConditionKey[];

export type MoveInKind = "immediate" | "date" | "consult" | "occupied" | "unknown";
export type MoveIn = {
  kind: MoveInKind;
  /** 'YYYY-MM'（kind=date の時） */
  date?: string;
  /** 上旬・中旬・下旬（日付だけ書いてある時は日から決める） */
  part?: "上旬" | "中旬" | "下旬";
  /** 日（「2026年10月20日」の 20） */
  day?: number;
  /** 現況（空室・居住中・退去予定）。書いていない・「ー」は null */
  current: "vacant" | "occupied" | "leaving" | null;
  /** 退去予定日（リアプロ「退去予定(10/31)」の 'MM-DD'。年は書いていない） */
  vacateMonthDay?: string;
  /** 元の文字（空白を詰めた物） */
  raw: string | null;
};

export type ContractTerm = { kind: "normal" | "fixed" | "unknown"; years?: number; raw: string | null };
/** 更新料。none＝なし／months・yen＝額／blank＝itandi の「ー」（空欄）／unlisted＝行が無い */
export type RenewalFee = { kind: "none" | "months" | "yen" | "blank" | "unlisted"; months?: number; yen?: number; basis?: "新賃料" | "旧賃料"; raw: string | null };

export type ListingTerms = {
  format: "itandi" | "realpro" | "unknown";
  hasText: boolean;
  /** 敷金（ヶ月）。なし・ー＝0、書いていない＝null。円で書いてある時は賃料で割った値（0.1刻み） */
  depositMonths: number | null;
  keyMoneyMonths: number | null;
  depositYen?: number | null;
  keyMoneyYen?: number | null;
  /** 敷金の「（償却）」「償却1ヶ月」の印 */
  depositAmortized?: boolean;
  /** 保証金（ヶ月）。なし・ー＝0 */
  guaranteeDeposit: number | null;
  guaranteeDepositYen?: number | null;
  /** 償却・敷引（ヶ月）。なし・ー＝0 */
  amortization: number | null;
  /** 敷礼の出どころ（表の行／備考の「敷金礼金0円」） */
  depositSource: "表" | "備考" | null;
  rentYen: number | null;
  /** 管理費・共益費（なし＝0）。円の礼金を総賃料で数える時に使う */
  adminFeeYen: number | null;
  builtYear: number | null;
  builtMonth: number | null;
  /** 築年数（基準日との差・切り捨て。築1年未満は0） */
  buildingAgeYears: number | null;
  buildingAgeMonths: number | null;
  /** 新築（「新築」の札・築年が基準日から12か月以内） */
  newBuild: boolean;
  moveIn: MoveIn;
  contract: ContractTerm;
  renewalFee: RenewalFee;
  /** フリーレント。書いていなければ null。月数が書いていなければ months=null */
  freeRent: { months: number | null } | null;
  conditions: Record<ConditionKey, TermFact>;
  /** 「単身限定」と書いてある（二人以上は入れない） */
  singleOnlyRestricted: boolean;
  areaSqm: number | null;
  /** 根拠の文字（空白を詰めた物） */
  evidence: Partial<Record<"deposit" | "keyMoney" | "guaranteeDeposit" | "amortization" | "built" | "newBuild" | "moveIn" | "contract" | "renewalFee" | "freeRent" | "area" | "rent", string>>;
};

// ───────────────────────── 正規化・数の読み ─────────────────────────

/** CJK 部首補助（U+2E80〜）は NFKC で直らない（itandi の「⻄」）→ よく出る字だけ置き換える */
const RADICAL_SUPPLEMENT: Record<string, string> = {
  "⻄": "西", "⻑": "長", "⻘": "青", "⻝": "食", "⻤": "鬼", "⻩": "黄", "⻫": "斉", "⻭": "歯", "⻯": "竜", "⻲": "亀", "⻨": "麦",
};
/** 文字層の揺れを揃える（康熙部首・全角・㎡→m2 は NFKC、部首補助は表で、「‧」「･」は「・」、横の空白は1つに） */
function norm(raw: string | null | undefined): string {
  return String(raw ?? "").normalize("NFKC").replace(/[⺀-⻿]/g, (c) => RADICAL_SUPPLEMENT[c] ?? c)
    .replace(/[‧･]/g, "・").replace(/[ \t]+/g, " ").replace(/\r/g, "");
}
/** 空白・改行を全部外す（「⼆⼈\n⼊居可」「楽器使用 不可」を1語に） */
const squash = (s: string) => s.replace(/\s+/g, "");
const toInt = (s: string) => parseInt(s.replace(/[,\s]/g, ""), 10);

/** 月の字の揺れ（ヶ ヵ カ か ケ 箇 と「月」の間の空白） */
const MONTH_UNIT = "\\s*[ヶヵカかケ箇ヵ]?\\s*月";
/** 表の1つの値（なし・ー・0・Nヶ月・N円・N万円・（償却）付き） */
const VALUE_RE_SRC = `(?:なし|無し|無|ー|-|―|‐|−|0(?![\\d.,])|[\\d.]+${MONTH_UNIT}(?:分)?|[\\d.,]+\\s*万\\s*円|[\\d,]+\\s*円)(?:\\s*[(（][^)）\\n]{0,12}[)）])?`;

type Amount = { kind: "none" | "dash" | "months" | "yen"; months?: number; yen?: number; note?: string; raw: string };

/** 値を読む（「なし」「ー」「1 ヶ月」「85,000円」「10万円」「1ヶ月(償却)」） */
function readAmount(raw: string): Amount | null {
  const s = raw.trim();
  const note = (s.match(/[(（]([^)）]{0,12})[)）]/) ?? [])[1];
  const body = s.replace(/[(（][^)）]*[)）]/, "").trim();
  if (/^(?:なし|無し|無)$/.test(body)) return { kind: "none", raw: s, note };
  if (/^(?:ー|-|―|‐|−)$/.test(body)) return { kind: "dash", raw: s, note };
  if (/^0$/.test(body)) return { kind: "none", raw: s, note };
  const m = body.match(new RegExp(`^([\\d.]+)${MONTH_UNIT}(?:分)?$`));
  if (m) { const v = parseFloat(m[1]); return Number.isFinite(v) ? { kind: "months", months: v, raw: s, note } : null; }
  const man = body.match(/^([\d.,]+)\s*万\s*円$/);
  if (man) return { kind: "yen", yen: Math.round(parseFloat(man[1].replace(/,/g, "")) * 10000), raw: s, note };
  const y = body.match(/^([\d,]+)\s*円$/);
  if (y) { const v = toInt(y[1]); return Number.isFinite(v) ? { kind: y && v === 0 ? "none" : "yen", yen: v, raw: s, note } : null; }
  return null;
}

/**
 * ありえない値を捨てた上で「ヶ月」に直す（円は賃料で割って 0.1 刻み。賃料が無ければ null）。
 * 2026-09-25 監査: リアプロ id 40〜44 の「礼金 85,000円」は賃料 77,000＋管理費 8,000＝総賃料の1ヶ月（特記「法人契約は礼金(総賃料の1ヶ月分)」）。
 *   賃料だけで割ると 1.1ヶ月になるので、総賃料で割ると 0.5 の倍数にぴったり（±2%）なる時は総賃料で数える
 */
function toMonths(a: Amount | null, rentYen: number | null, maxMonths = 6, adminFeeYen: number | null = null): { months: number | null; yen: number | null } {
  if (!a) return { months: null, yen: null };
  if (a.kind === "none" || a.kind === "dash") return { months: 0, yen: 0 };
  if (a.kind === "months") {
    const v = a.months as number;
    return v >= 0 && v <= maxMonths ? { months: v, yen: null } : { months: null, yen: null };
  }
  const yen = a.yen as number;
  if (!(yen >= 0 && yen <= 1_500_000)) return { months: null, yen: null };
  if (rentYen == null || rentYen <= 0) return { months: null, yen };
  let m = Math.round((yen / rentYen) * 10) / 10;
  if (adminFeeYen != null && adminFeeYen > 0) {
    const onRent = yen / rentYen, onTotal = yen / (rentYen + adminFeeYen);
    const nearHalf = (x: number) => x > 0 && Math.abs(x * 2 - Math.round(x * 2)) <= 0.04;
    if (!nearHalf(onRent) && nearHalf(onTotal)) m = Math.round(onTotal * 2) / 2;
  }
  return m <= maxMonths ? { months: m, yen } : { months: null, yen: null };
}

function detectFormat(text: string): ListingTerms["format"] {
  if (/RealNetPro|号室名|現況\/入居時期|間取タイプ/.test(text)) return "realpro";
  if (/所在階|主要採光面|入居可能時期|敷引償却/.test(text)) return "itandi";
  return "unknown";
}

const partFromDay = (d: number): "上旬" | "中旬" | "下旬" => (d <= 10 ? "上旬" : d <= 20 ? "中旬" : "下旬");

function refYm(today: Date | string | undefined): { y: number; m: number } {
  const d = today instanceof Date ? today : today ? new Date(today) : new Date();
  // JST で数える
  const j = new Date(d.getTime() + 9 * 3600_000);
  return { y: j.getUTCFullYear(), m: j.getUTCMonth() + 1 };
}

// ───────────────────────── 各項目 ─────────────────────────

/** 入居時期の値（「即入」「即入居可」「相談」「2026年11月上旬」「2026年10月20日」「11月下旬」「ー」） */
function readMoveInTiming(raw: string, ref: { y: number; m: number }): Omit<MoveIn, "current" | "raw"> {
  const s = squash(raw);
  if (!s || /^(?:ー|-|―)$/.test(s)) return { kind: "unknown" };
  if (/^即(?:入居?|日|時)?(?:可能?)?|^即$/.test(s)) return { kind: "immediate" };
  const m = s.match(/^(?:(\d{4})年)?(\d{1,2})月(?:(\d{1,2})日|(上旬|中旬|下旬|初旬|末|末日|頃))?/);
  if (m) {
    const mon = parseInt(m[2], 10);
    if (mon < 1 || mon > 12) return { kind: "unknown" };
    let y = m[1] ? parseInt(m[1], 10) : ref.y;
    if (!m[1] && mon < ref.m - 1) y += 1; // 年の無い「1月上旬」は来年
    if (y < ref.y - 1 || y > ref.y + 2) return { kind: "unknown" };
    const day = m[3] ? parseInt(m[3], 10) : undefined;
    const p = m[4] === "初旬" ? "上旬" : m[4] === "末" || m[4] === "末日" ? "下旬" : (m[4] as "上旬" | "中旬" | "下旬" | "頃" | undefined);
    const part = day != null && day >= 1 && day <= 31 ? partFromDay(day) : p === "上旬" || p === "中旬" || p === "下旬" ? p : undefined;
    return { kind: "date", date: `${y}-${String(mon).padStart(2, "0")}`, ...(part ? { part } : {}), ...(day != null && day >= 1 && day <= 31 ? { day } : {}) };
  }
  if (/相談|応相談|要相談|調整/.test(s)) return { kind: "consult" };
  return { kind: "unknown" };
}

function readCurrent(raw: string): MoveIn["current"] {
  const s = squash(raw);
  if (/退去予定|空き予定|空予定/.test(s)) return "leaving";
  if (/居住中|入居中|賃貸中/.test(s)) return "occupied";
  if (/^(?:空室|空き|空家|空)/.test(s)) return "vacant";
  return null;
}

function parseMoveIn(text: string, format: ListingTerms["format"], ref: { y: number; m: number }): MoveIn {
  // リアプロ「現況/入居時期 退去予定(10/31) / 相談」（値が次の行に割れても読む）
  const rp = text.match(/現況\s*\/\s*入居時期[ \t]*\n?[ \t]*([^\n]*)/);
  if (rp && rp[1].trim()) {
    const raw = rp[1].trim();
    // 「退去予定(10/31)」の中の「/」で割らない
    const cleaned = raw.replace(/[(（][^)）]*[)）]/g, (x) => x.replace(/\//g, "∕"));
    const parts = cleaned.split("/").map((x) => x.trim());
    const cur = readCurrent(parts[0] ?? "");
    const timing = parts.length >= 2 ? readMoveInTiming(parts.slice(1).join("/"), ref) : readMoveInTiming(parts[0] ?? "", ref);
    let t = timing;
    // 「空室 / ー」＝空室なので即入居と読んでよい？ → 書いていないので unknown のまま（現況だけ持つ）
    if (t.kind === "unknown" && cur === "occupied") t = { kind: "occupied" };
    const vd = raw.match(/退去予定\s*[(（]\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*[)）]/);
    const vacate = vd && +vd[1] >= 1 && +vd[1] <= 12 && +vd[2] >= 1 && +vd[2] <= 31 ? `${vd[1].padStart(2, "0")}-${vd[2].padStart(2, "0")}` : undefined;
    return { ...t, current: cur, ...(vacate ? { vacateMonthDay: vacate } : {}), raw: squash(raw) };
  }
  // itandi「現況 居住中 入居可能時期 2026 年 11 月上旬」
  const itCur = text.match(/(?:^|\n)[ \t]*現況[ \t]+([^\n]*?)[ \t]*(?=入居可能時期|\n|$)/);
  const itTime = text.match(/入居可能時期[ \t]*\n?[ \t]*([^\n]*)/);
  if (itTime || (format === "itandi" && itCur)) {
    const cur = itCur ? readCurrent(itCur[1]) : null;
    const rawT = (itTime?.[1] ?? "").replace(/\s*(?:契約期間|解約予告).*$/, "").trim();
    let t = readMoveInTiming(rawT, ref);
    if (t.kind === "unknown" && cur === "occupied") t = { kind: "occupied" };
    const raw = [itCur ? `現況${squash(itCur[1])}` : null, itTime ? `入居可能時期${squash(rawT)}` : null].filter(Boolean).join(" ");
    return { ...t, current: cur, raw: raw || null };
  }
  // 形の分からない資料: 「入居時期 …」「入居日 …」
  const any = text.match(/入居(?:時期|日|可能日)[ \t:：]*([^\n]{1,20})/);
  if (any) {
    const t = readMoveInTiming(any[1], ref);
    return { ...t, current: null, raw: squash(any[0]) };
  }
  return { kind: "unknown", current: null, raw: null };
}

function parseContract(text: string): ContractTerm {
  const m = text.match(/契約期間[ \t]*\n?[ \t]*([^\n]*)/);
  if (!m) {
    if (/定期借家|定期建物賃貸借|定借/.test(squash(text))) return { kind: "fixed", raw: (squash(text).match(/定期借家|定期建物賃貸借|定借/) ?? [])[0] ?? null };
    return { kind: "unknown", raw: null };
  }
  const raw = squash(m[1].replace(/\s*解約予告.*$/, ""));
  const kind: ContractTerm["kind"] = /定期|定借/.test(raw) ? "fixed" : /普通/.test(raw) ? "normal" : "unknown";
  const y = raw.match(/(\d{1,2}(?:\.\d)?)年/);
  const mo = raw.match(/(\d{1,3})(?:ヶ|ヵ|カ|か|ケ)?月/);
  let years: number | undefined;
  if (y) { const v = parseFloat(y[1]); if (v > 0 && v <= 20) years = v; }
  else if (mo) { const v = parseInt(mo[1], 10) / 12; if (v > 0 && v <= 20) years = Math.round(v * 10) / 10; }
  return { kind, ...(years != null ? { years } : {}), raw: raw || null };
}

function parseRenewal(text: string, rentYen: number | null): RenewalFee {
  // 行頭か「保険加入 … 更新料 …」の同じ行（itandi）。特記の「・更新料:旧総賃料」は表が無い時だけ
  const m = text.match(/(?:^|\n|[ \t])更新料[ \t]*\n?[ \t]*([^\n]*)/);
  if (!m) return { kind: "unlisted", raw: null };
  const raw = squash(m[1]);
  const basis = /新賃料/.test(raw) ? "新賃料" as const : /旧/.test(raw) ? "旧賃料" as const : undefined;
  const body = raw.replace(/^[:：]/, "").replace(/^(?:新|旧)?(?:総)?賃料の?/, "");
  if (!body && basis) return { kind: "months", months: 1, basis, raw }; // 「更新料:旧総賃料」＝1ヶ月
  if (/^(?:なし|無し|無|0円|不要)/.test(body)) return { kind: "none", raw };
  if (/^(?:ー|-|―)$/.test(body)) return { kind: "blank", raw };
  const mm = body.match(/^([\d.]+)(?:ヶ|ヵ|カ|か|ケ|箇)?月/);
  if (mm) { const v = parseFloat(mm[1]); return v > 0 && v <= 3 ? { kind: "months", months: v, ...(basis ? { basis } : {}), raw } : { kind: "unlisted", raw }; }
  const yy = body.match(/^([\d,]+)円/);
  if (yy) {
    const v = toInt(yy[1]);
    if (!(v > 0 && v <= 1_000_000)) return { kind: "unlisted", raw };
    if (rentYen != null && v > rentYen * 3) return { kind: "unlisted", raw };
    return { kind: "yen", yen: v, raw };
  }
  return { kind: "unlisted", raw };
}

function parseFreeRent(flat: string): { months: number | null } | null {
  // 「フリーレント1ヶ月」「フリーレント:1ヶ月」「FR1ヶ月」。「フリーレントなし」は null
  const m = flat.match(/(?:フリーレント|FR)[:：]?(?:期間)?[:：]?(\d{1,2}(?:\.\d)?)(?:ヶ|ヵ|カ|か|ケ|箇)?月/);
  if (m) { const v = parseFloat(m[1]); return { months: v > 0 && v <= 12 ? v : null }; }
  if (/フリーレント(?:なし|無し|無|不可)/.test(flat)) return null;
  if (/フリーレント/.test(flat)) return { months: null };
  return null;
}

type CondRule = { ok?: RegExp[]; consult?: RegExp[]; ng?: RegExp[] };
// 照らす文字は空白・改行を詰めた物（squash 済み）。ok ＞ consult ＞ ng の順（矛盾する記載では不可にしない）
const COND_RULES: Record<ConditionKey, CondRule> = {
  instrument: {
    ok: [/楽器(?:使用|演奏)?(?:可能?|OK)(?!否)/],
    consult: [/楽器(?:使用|演奏)?(?:相談|応相談)/],
    ng: [/楽器(?:使用|演奏)?(?:不可|禁止|NG|×)/],
  },
  corporate: {
    ok: [/法人(?:契約|名義)?(?:可能?|OK)(?!否)/],
    consult: [/法人(?:契約|名義)?(?:相談|応相談)/, /法人契約(?:は|の場合)[、,]?.{0,20}?(?:礼金|積み増し|増額|要)/, /法人契約の場合は?相談/],
    ng: [/法人(?:契約|名義)?(?:不可|NG|×)/],
  },
  foreigner: {
    ok: [/外国(?:人|籍)(?:の方)?(?:契約|入居)?(?:可能?|OK)(?!否)/],
    consult: [/外国(?:人|籍)(?:の方)?(?:契約|入居)?(?:相談|応相談)/, /外国(?:人|籍)の(?:申込者|方|入居者)(?:様)?は.{0,12}?(?:敷金|保証|礼金)/],
    ng: [/外国(?:人|籍)(?:の方)?(?:契約|入居)?(?:不可|NG|×)/],
  },
  student: {
    ok: [/学生(?:可|OK|歓迎|限定|専用)(?!否)/],
    consult: [/学生(?:相談|応相談)/],
    ng: [/学生(?:不可|NG|×)/],
  },
  office: {
    ok: [/(?:事務所|SOHO)(?:使用|利用)?(?:可能?|OK)(?!否)/i],
    consult: [/(?:事務所|SOHO)(?:使用|利用)?(?:相談|応相談)/i],
    ng: [/(?:事務所|SOHO)(?:使用|利用)?(?:不可|禁止|NG|×)/i],
  },
  singleOnly: {
    ok: [/単身(?:者)?(?:可|OK|限定|専用|向け)(?!否)/],
    consult: [/単身(?:者)?(?:相談|応相談)/],
    ng: [/単身(?:者)?(?:不可|NG|×)/],
  },
  twoPerson: {
    ok: [/(?:二|2)人入居(?:可能?|OK)(?!否)/, /カップル(?:可|OK)|同棲(?:可|OK)/],
    consult: [/(?:二|2)人入居(?:相談|応相談)/],
    ng: [/(?:二|2)人入居(?:不可|NG|×)/, /単身(?:者)?(?:限定|専用)/],
  },
  roomShare: {
    ok: [/ルームシェア(?:可能?|OK)(?!否)/],
    consult: [/ルームシェア(?:相談|応相談)/],
    ng: [/ルームシェア(?:不可|NG|×)/],
  },
  children: {
    ok: [/(?:子供|子ども|お子様)(?:可|OK)(?!否)/],
    consult: [/(?:子供|子ども|お子様)(?:相談|応相談)/],
    ng: [/(?:子供|子ども|お子様)(?:不可|NG|×)/],
  },
};

function firstMatch(text: string, res: RegExp[] | undefined): string | null {
  for (const re of res ?? []) { const m = text.match(re); if (m && m[0]) return m[0]; }
  return null;
}

/** 表の行「敷金 なし」（行頭・値が次の行に割れても読む）。行の中に「礼金 …」が続いても最初の値だけ */
function tableValue(text: string, label: string): string | null {
  const re = new RegExp(`(?:^|\\n)[ \\t]*${label}[ \\t]*[:：]?[ \\t]*\\n?[ \\t]*(${VALUE_RE_SRC})`);
  const m = text.match(re);
  return m ? m[1] : null;
}

// ───────────────────────── 本体 ─────────────────────────

/**
 * 資料の文字層から募集の条件を読む（決定論・投げない）。
 * @param opts.today 築年数・年の無い入居時期の基準日（既定は今）
 */
export function parseListingTerms(raw: string | null | undefined, opts?: { today?: Date | string }): ListingTerms {
  const text = norm(raw);
  const format = detectFormat(text);
  const ref = refYm(opts?.today);
  const conditions = Object.fromEntries(CONDITION_KEYS.map((k) => [k, { status: "unlisted", evidence: null } as TermFact])) as Record<ConditionKey, TermFact>;
  const out: ListingTerms = {
    format, hasText: text.trim().length >= 40,
    depositMonths: null, keyMoneyMonths: null, guaranteeDeposit: null, amortization: null, depositSource: null, rentYen: null, adminFeeYen: null,
    builtYear: null, builtMonth: null, buildingAgeYears: null, buildingAgeMonths: null, newBuild: false,
    moveIn: { kind: "unknown", current: null, raw: null }, contract: { kind: "unknown", raw: null }, renewalFee: { kind: "unlisted", raw: null },
    freeRent: null, conditions, singleOnlyRestricted: false, areaSqm: null, evidence: {},
  };
  if (!out.hasText) return out;
  const flat = squash(text);

  // ── 賃料（円の敷礼をヶ月に直すため）
  const rent = text.match(/賃料[ \t]*\n?[ \t]*([\d,]+)\s*円/);
  if (rent) { const v = toInt(rent[1]); if (v >= 10_000 && v <= 2_000_000) { out.rentYen = v; out.evidence.rent = `賃料${rent[1]}円`; } }
  const adm = text.match(/(?:共益費・管理費|管理費・共益費|管理費|共益費)[ \t]*\n?[ \t]*(なし|無し|-|ー|[\d,]+\s*円)/);
  if (adm) { const v = /^[\d,]/.test(adm[1]) ? toInt(adm[1]) : 0; if (v >= 0 && v <= 200_000) out.adminFeeYen = v; }

  // ── 敷金・礼金・保証金・償却
  let dep: Amount | null = null, key: Amount | null = null, gua: Amount | null = null, amo: Amount | null = null;
  // itandi「敷金 / 礼金 / 保証金 なし / 1 ヶ月 / ー 敷引償却 ー」（値が次の行に割れたら次の行も足す）
  const tri = text.match(/敷金\s*\/\s*礼金\s*\/\s*保証金[ \t]*([^\n]*)(?:\n([^\n]*))?/);
  if (tri) {
    const vr = new RegExp(`^\\s*(${VALUE_RE_SRC})\\s*\\/\\s*(${VALUE_RE_SRC})\\s*\\/\\s*(${VALUE_RE_SRC})`);
    const one = tri[1].match(vr) ?? `${tri[1]} ${tri[2] ?? ""}`.match(vr);
    if (one) {
      dep = readAmount(one[1]); key = readAmount(one[2]); gua = readAmount(one[3]);
      out.evidence.deposit = squash(`敷金/礼金/保証金 ${one[1]}/${one[2]}/${one[3]}`);
      out.evidence.keyMoney = out.evidence.deposit;
    }
    const sb = text.match(new RegExp(`敷引償却[ \\t]*(${VALUE_RE_SRC})`));
    if (sb) { amo = readAmount(sb[1]); out.evidence.amortization = squash(`敷引償却${sb[1]}`); }
  }
  if (!dep && !key) {
    // リアプロ「敷金 なし」「礼金 2ヶ月」「保証金 なし 償却・敷引 なし」
    const d = tableValue(text, "敷金"), k = tableValue(text, "礼金");
    if (d) { dep = readAmount(d); out.evidence.deposit = squash(`敷金${d}`); }
    if (k) { key = readAmount(k); out.evidence.keyMoney = squash(`礼金${k}`); }
    const g = tableValue(text, "保証金");
    if (g) { gua = readAmount(g); out.evidence.guaranteeDeposit = squash(`保証金${g}`); }
    const a = text.match(new RegExp(`(?:償却・敷引|敷引・償却|敷引|償却)[ \\t]*[:：]?[ \\t]*(${VALUE_RE_SRC})`));
    if (a) { amo = readAmount(a[1]); out.evidence.amortization = squash(a[0]); }
  }
  if (dep || key) out.depositSource = "表";
  const dm = toMonths(dep, out.rentYen, 6, out.adminFeeYen), km = toMonths(key, out.rentYen, 6, out.adminFeeYen);
  const gm = toMonths(gua, out.rentYen, 6, out.adminFeeYen), am = toMonths(amo, out.rentYen, 6, out.adminFeeYen);
  out.depositMonths = dm.months; out.keyMoneyMonths = km.months; out.guaranteeDeposit = gm.months; out.amortization = am.months;
  if (dm.yen != null && dep?.kind === "yen") out.depositYen = dm.yen;
  if (km.yen != null && key?.kind === "yen") out.keyMoneyYen = km.yen;
  if (gm.yen != null && gua?.kind === "yen") out.guaranteeDepositYen = gm.yen;
  if (dep?.note && /償却|敷引/.test(dep.note)) out.depositAmortized = true;
  // 表が無い時だけ、備考の「敷金礼金0円」「敷礼0」「敷金・礼金なし」「ゼロゼロ」
  if (out.depositSource == null) {
    const z = flat.match(/敷金[・/]?礼金(?:0円|ゼロ|なし|無し|不要)|敷礼(?:0|ゼロ|なし|無し)|ゼロゼロ物件/);
    if (z) { out.depositMonths = 0; out.keyMoneyMonths = 0; out.depositSource = "備考"; out.evidence.deposit = z[0]; out.evidence.keyMoney = z[0]; }
  }

  // ── 築年・新築
  const b = text.match(/(?:^|\n|[ \t])築年(?:数|月)?[ \t]*[:：]?[ \t]*\n?[ \t]*(\d{4})[ \t]*年[ \t]*(?:(\d{1,2})[ \t]*月)?/);
  if (b) {
    const y = parseInt(b[1], 10), mo = b[2] ? parseInt(b[2], 10) : null;
    if (y >= 1950 && y <= ref.y + 1 && (mo == null || (mo >= 1 && mo <= 12))) {
      out.builtYear = y; out.builtMonth = mo;
      out.evidence.built = squash(b[0]);
      const months = (ref.y - y) * 12 + (ref.m - (mo ?? 1));
      out.buildingAgeMonths = Math.max(0, months);
      out.buildingAgeYears = Math.floor(out.buildingAgeMonths / 12);
    }
  }
  // 「新築」の札（行の中の単独の語・築年の値）。「新築物件のみ退去時」「新築時」「新築同様」は札ではない
  const nb = text.match(/(?:^|\n|[ \t【\[■★●・])新築(?:[・/]?未入居)?(?=[ \t】\]]*(?:\n|$)|[ \t】\]・])/) ?? text.match(/築年(?:数|月)?[ \t]*新築/);
  if (nb && !/新築(?:物件のみ|時|同様|当時)/.test(text.slice(nb.index ?? 0, (nb.index ?? 0) + nb[0].length + 6))) {
    out.newBuild = true; out.evidence.newBuild = squash(nb[0]);
    if (out.buildingAgeYears == null) { out.buildingAgeYears = 0; out.buildingAgeMonths = 0; }
  } else if (out.buildingAgeMonths != null && out.buildingAgeMonths < 12) {
    out.newBuild = true; out.evidence.newBuild = `${out.evidence.built}（基準日から12か月以内）`;
  }

  // ── 入居時期・契約・更新料・フリーレント
  out.moveIn = parseMoveIn(text, format, ref);
  if (out.moveIn.raw) out.evidence.moveIn = out.moveIn.raw;
  out.contract = parseContract(text);
  if (out.contract.raw) out.evidence.contract = out.contract.raw;
  out.renewalFee = parseRenewal(text, out.rentYen);
  if (out.renewalFee.raw) out.evidence.renewalFee = `更新料${out.renewalFee.raw}`;
  out.freeRent = parseFreeRent(flat);
  if (out.freeRent) out.evidence.freeRent = (flat.match(/(?:フリーレント|FR)[^・■★,、\s]{0,8}/) ?? [])[0] ?? "フリーレント";

  // ── 入居の条件（全文を詰めて照らす）
  for (const k of CONDITION_KEYS) {
    const r = COND_RULES[k];
    const ok = firstMatch(flat, r.ok);
    if (ok) { conditions[k] = { status: "ok", evidence: ok }; continue; }
    const cs = firstMatch(flat, r.consult);
    if (cs) { conditions[k] = { status: "consult", evidence: cs }; continue; }
    const ng = firstMatch(flat, r.ng);
    if (ng) conditions[k] = { status: "ng", evidence: ng };
  }
  const so = flat.match(/単身(?:者)?(?:限定|専用)/);
  if (so) {
    out.singleOnlyRestricted = true;
    // 「単身限定」と「二人入居可」が両方ある矛盾は、二人入居を相談に（どちらかに決めない）
    if (conditions.twoPerson.status === "ok") conditions.twoPerson = { status: "consult", evidence: `${conditions.twoPerson.evidence}／${so[0]}` };
  }

  // ── 専有面積
  const area = text.match(/専有面積[ \t]*[:：]?[ \t]*\n?[ \t]*(\d+(?:\.\d+)?)\s*(?:m2|m²|平米)/i);
  if (area) { const v = parseFloat(area[1]); if (v >= 5 && v <= 500) { out.areaSqm = v; out.evidence.area = `専有面積${area[1]}m2`; } }
  return out;
}

// ───────────────────────── 判定に渡す形 ─────────────────────────

/**
 * property-brain の PropertyDataLike（deposit_months・key_money_months）と PropertyFacts.buildingAge に渡す形。
 * 説明文から読めた値がある時はそちらが先（呼ぶ側で null の所だけ埋める）。
 */
export function termsToBrainData(t: ListingTerms): { deposit_months: number | null; key_money_months: number | null; building_age: number | null } {
  return { deposit_months: t.depositMonths, key_money_months: t.keyMoneyMonths, building_age: t.buildingAgeYears };
}

/** 入居できる一番早い日（'YYYY-MM-DD'）。即入居＝基準日、上旬＝1日・中旬＝11日・下旬＝21日・月だけ＝1日。相談・不明・居住中は null */
export function moveInAvailableFrom(m: MoveIn, opts?: { today?: Date | string }): string | null {
  if (m.kind === "immediate") {
    const d = opts?.today instanceof Date ? opts.today : opts?.today ? new Date(opts.today) : new Date();
    return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  }
  if (m.kind !== "date" || !m.date) return null;
  const day = m.day ?? (m.part === "中旬" ? 11 : m.part === "下旬" ? 21 : 1);
  return `${m.date}-${String(day).padStart(2, "0")}`;
}

/**
 * 入居の希望日（その日までに入りたい 'YYYY-MM-DD'）と照らす。
 * ok＝希望日までに入れる／late＝入れるのが希望日より graceDays（既定14日）より後／unknown＝相談・不明・居住中（要確認・0点）
 */
export function compareMoveIn(m: MoveIn, wantBy: string | null | undefined, opts?: { today?: Date | string; graceDays?: number }): "ok" | "late" | "unknown" {
  if (!wantBy || !/^\d{4}-\d{2}-\d{2}$/.test(wantBy)) return "unknown";
  const from = moveInAvailableFrom(m, opts);
  if (!from) {
    // 2026-09-25 監査 E4: 「退去予定(10/31)/相談」は相談でも退去日の翌日より前には入れない（リアプロ）。
    //   退去日の翌日が希望日より graceDays を超えて遅い時だけ late。早い時は「入れる」とは言えない（相談）ので unknown のまま
    const v = vacateNextDay(m, opts);
    if (v && (Date.parse(v) - Date.parse(wantBy)) / 86_400_000 > (opts?.graceDays ?? 14)) return "late";
    return "unknown";
  }
  const diff = (Date.parse(from) - Date.parse(wantBy)) / 86_400_000;
  return diff > (opts?.graceDays ?? 14) ? "late" : "ok";
}

/**
 * 退去予定日（'MM-DD'・年は書いていない）の翌日 'YYYY-MM-DD'。年は基準日（JST）から: 基準の月より2か月以上前の月は来年（readMoveInTiming と同じ線）。
 * 退去日が無い・読めない時は null
 */
export function vacateNextDay(m: MoveIn, opts?: { today?: Date | string }): string | null {
  if (!m.vacateMonthDay || !/^\d{2}-\d{2}$/.test(m.vacateMonthDay)) return null;
  const ref = refYm(opts?.today);
  const mon = parseInt(m.vacateMonthDay.slice(0, 2), 10);
  const day = parseInt(m.vacateMonthDay.slice(3), 10);
  // 反証レビュー: 1月の基準で「退去予定(12/31)」は去年の12月（もう空いた）。今年の12月と読むと「入居が遅い」の誤保留になる → 10か月以上先の月は去年
  const y = mon < ref.m - 1 ? ref.y + 1 : mon - ref.m >= 10 ? ref.y - 1 : ref.y;
  const d = new Date(Date.UTC(y, mon - 1, day + 1));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** 監査・画面用の1行（「敷0 礼1 保0 築2008年6月(18年) 入居:2026-11上旬(居住中) 普通2年 更新1ヶ月 楽器× 外国籍○」） */
export function formatListingTerms(t: ListingTerms): string {
  const v = (x: number | null) => (x == null ? "?" : String(x));
  const mi = t.moveIn;
  const move = mi.kind === "date" ? `${mi.date}${mi.day ? `-${mi.day}` : mi.part ?? ""}` : mi.kind;
  const cur = mi.current ? `(${mi.current})` : "";
  const ren = t.renewalFee.kind === "months" ? `${t.renewalFee.months}ヶ月` : t.renewalFee.kind === "yen" ? `${t.renewalFee.yen}円` : t.renewalFee.kind;
  const mark: Record<TermStatus, string> = { ok: "○", ng: "×", consult: "△", unlisted: "" };
  const conds = CONDITION_KEYS.filter((k) => t.conditions[k].status !== "unlisted").map((k) => `${CONDITION_LABELS[k]}${mark[t.conditions[k].status]}`).join(" ");
  return [
    `敷${v(t.depositMonths)} 礼${v(t.keyMoneyMonths)} 保${v(t.guaranteeDeposit)}${t.depositSource === "備考" ? "(備考)" : ""}`,
    t.builtYear ? `築${t.builtYear}年${t.builtMonth ?? "?"}月(${t.buildingAgeYears}年)${t.newBuild ? "新築" : ""}` : t.newBuild ? "新築" : "築?",
    `入居:${move}${cur}`,
    `${t.contract.kind}${t.contract.years ?? ""}`,
    `更新${ren}`,
    t.freeRent ? `FR${t.freeRent.months ?? "?"}` : "",
    t.areaSqm != null ? `${t.areaSqm}㎡` : "",
    conds,
  ].filter(Boolean).join(" ");
}
