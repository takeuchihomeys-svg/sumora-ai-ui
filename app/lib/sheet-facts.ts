// app/lib/sheet-facts.ts（純関数・DB 依存なし）
// 物件資料の「文字層」から事実を取り、画像（間取り図）から読んだ事実と突き合わせ、お客様の希望と照合する。
//
// 2026-09-24 竹内「表の文字は PDF の文字層（pdf-text）から取る」「間取り図だけを読み取る形なら物件のずれが起きないかも調査。
//   ちゃんと物件の間取り図と一致しているかも。食い違いは点を出さず『要確認』」「読んだ結果を物件ごとに保存し、2回目以降は画像を読み直さない
//   （希望との照合は文字だけ）」
//
// 調査（2026-09-24・property_pickups の realpro 全18行）:
//   - 説明文と文字層の物件名（NFKC・Ⅶ→VII）・賃料・専有面積・間取りは 18/18 一致。1ページ目と2ページ目の物件名・号室・賃料も 18/18 一致
//   - 別の部屋でも間取り図・写真が1バイトも違わない資料がある（37と41・40と43・42と44）＝写真は「その部屋の物」とは限らない
//   - 同じ棟は面積も同じ（21.09㎡ が5室）で、区別できるのは賃料だけ。号室は説明文に無い（room_no も全行 null）
//   - 文字層に帖数がある資料は 15件中3件（「1LDK[LDK11.9 x 洋4.4]」「1K[洋室7帖]」）。読めた3件は目で見て全部一致
// 決まり（誤って点を出さない側に倒す）:
//   - 説明文と文字層の 物件名・賃料・面積・間取り・号室 が1つでも違う → 要確認（まとめ PDF で別物件の資料が付いた）
//   - 1ページ目と2ページ目の物件名・号室が違う → 要確認
//   - 間取り図が無い・読めない（fp_ok=false）・別の部屋の図（other_unit）→ 要確認
//   - 読んだ間取りの型が文字層と違う／文字層の帖数と 0.3帖を超えて違う／帖数の合計×1.62㎡ が専有面積を超える・25%未満／
//     図の中の㎡が専有面積と違う → 要確認
import { normalizeFloorPlanToken } from "./property-brain";
import { parseRentFromSummary } from "./property-summary-parse";
import { parseSummaryHead } from "./sent-property-filter";
import { normalizeRoomNo } from "./sent-property-record";
import { buildingKey, parseAreaSqm } from "./pickup-dedupe";
import { wantFeatures, type ImageWant, type WantCheck } from "./image-wants";
import type { SheetImageFacts } from "./sheet-prompt";

/** 1帖の広さ（㎡）。帖数の合計がこれ×専有面積を超えたら別の広い部屋の図 */
export const JO_SQM = 1.62;
/** 文字層の帖数と読んだ帖数の差の許し（帖） */
export const JO_TOLERANCE = 0.3;

export type SheetTextFacts = {
  hasText: boolean;
  name: string | null;
  /** 資料の中の物件名（ページごと）。まとめ PDF のずれを見る */
  names: string[];
  roomNo: string | null;
  roomNos: string[];
  floor: number | null;
  address: string | null;
  madori: string | null;
  /** 間取タイプの括弧の中の帖数（例「LDK11.9 x 洋4.4」→ [{LDK,11.9},{洋,4.4}]） */
  jo: Array<{ kind: string; jo: number }>;
  areaSqm: number | null;
  rentYen: number | null;
  direction: string | null;
  /** 備考・設備・条件の文（改行を外して1行に。キーワードで照らす） */
  features: string;
};

const nfkc = (s: string) => s.normalize("NFKC");
const flat = (s: string) => s.replace(/\s*\n\s*/g, "");

/**
 * 区切りの見出し（「設 備」のように字間が空き、1行に見出しだけ）の位置。
 * 見出しの行に限る: 上の注意書き「写真、間取図面、設備、概要などが…」の「設備」に当てない（2026-09-24 実物で当たった）
 */
function sectionIndex(text: string, label: string): number {
  const re = new RegExp(`(?:^|\\n)[ \\t]*${label.split("").join("[ \\t]*")}[ \\t]*(?=\\n|$)`);
  const m = re.exec(text);
  return m ? m.index : -1;
}

/** 資料の文字層（pdf-text の text・複数ページ可）から事実を取る */
export function parseSheetText(raw: string | null | undefined): SheetTextFacts {
  const text = nfkc(String(raw ?? ""));
  const empty: SheetTextFacts = { hasText: false, name: null, names: [], roomNo: null, roomNos: [], floor: null, address: null, madori: null, jo: [], areaSqm: null, rentYen: null, direction: null, features: "" };
  if (text.trim().length < 40) return empty;
  const names = [...text.matchAll(/物件名[ \t]+([^\n]+)/g)].map((m) => m[1].trim()).filter(Boolean);
  const roomLines = [...text.matchAll(/号室名[ \t]+([^\n]+)/g)].map((m) => m[1].trim());
  const roomNos = roomLines.map((l) => normalizeRoomNo((l.match(/^([0-9]{1,5})/) ?? [])[1] ?? "")).filter(Boolean);
  const floorM = text.match(/[（(]\s*(\d{1,2})\s*階部分\s*[)）]/);
  const addrM = text.match(/所在地[ \t]*\n?[ \t]*([^\n]+)/);
  const madoriLine = (text.match(/間取タイプ[ \t]+([^\n]+)/) ?? [])[1] ?? "";
  const madori = normalizeFloorPlanToken(madoriLine);
  const bracket = (madoriLine.match(/[[［(（]([^\]］)）]+)[\]］)）]/) ?? [])[1] ?? "";
  const jo: Array<{ kind: string; jo: number }> = [];
  for (const m of bracket.matchAll(/(S?LDK|LD|DK|K|洋室?|和室?|サービスルーム|S)\s*(\d+(?:\.\d+)?)\s*(?:帖|畳|J)?/g)) {
    const v = parseFloat(m[2]);
    if (Number.isFinite(v) && v >= 1.5 && v <= 60) jo.push({ kind: joKind(m[1]), jo: v });
  }
  const areaM = text.match(/専有面積[ \t]+(\d+(?:\.\d+)?)\s*(?:m2|㎡|平米)/i);
  const rentM = text.match(/賃料[ \t]*\n?[ \t]*([\d,]+)\s*円/);
  const dirM = text.match(/開口部方位[ \t]+([東西南北]{1,2})/);
  // 備考〜設備〜条件（特記事項・会社の帯は入れない＝保証会社の「ペット飼育時は…」のような文で誤って当てない）
  const iRemarks = sectionIndex(text, "備考"), iEquip = sectionIndex(text, "設備"), iCond = sectionIndex(text, "条件");
  const iEnd = (() => { const a = text.indexOf("取引態様"), b = text.indexOf("特記事項"); return [a, b].filter((x) => x >= 0).sort((x, y) => x - y)[0] ?? -1; })();
  const start = [iRemarks, iEquip, iCond].filter((x) => x >= 0).sort((x, y) => x - y)[0] ?? -1;
  const features = start >= 0 ? flat(text.slice(start, iEnd > start ? iEnd : undefined)) : "";
  return {
    hasText: true,
    name: names[0] ?? null,
    names: [...new Set(names)],
    roomNo: roomNos[0] ?? null,
    roomNos: [...new Set(roomNos)],
    floor: floorM ? parseInt(floorM[1], 10) : null,
    address: addrM ? addrM[1].trim() : null,
    madori,
    jo,
    areaSqm: areaM ? parseFloat(areaM[1]) : null,
    rentYen: rentM ? parseInt(rentM[1].replace(/,/g, ""), 10) : null,
    direction: dirM ? dirM[1] : null,
    features,
  };
}

function joKind(s: string): string {
  const t = s.replace(/^S(?=LDK)/, "");
  if (/^(LDK|LD)$/.test(t)) return "LDK";
  if (t === "DK") return "DK";
  if (t === "K") return "K";
  if (/^和/.test(t)) return "和";
  if (/^(S|サービスルーム)$/.test(t)) return "S";
  return "洋";
}

/** 読んだ部屋の名前（「洋室」「LDK」「寝室」…）を帖数の種類に */
export function roomKindOf(name: string): string | null {
  const t = nfkc(String(name ?? "")).toUpperCase();
  if (/L\.?D\.?K|LD|リビング/.test(t)) return "LDK";
  if (/D\.?K|ダイニング/.test(t)) return "DK";
  if (/^K$|キッチン|台所/.test(t)) return "K";
  if (/和/.test(t)) return "和";
  if (/洋|寝室|居室|ROOM|BR/.test(t)) return "洋";
  return null;
}

/** 説明文（拡張ツールの buildPropertySummary）から比べる材料 */
export function parseSummaryFacts(summary: string | null | undefined): { name: string | null; roomNo: string | null; rentYen: number | null; areaSqm: number | null; madori: string | null } {
  const s = String(summary ?? "");
  const head = parseSummaryHead(s);
  const rest = s.split("\n").slice(1);
  let madori: string | null = null;
  for (const l of rest) { const fp = normalizeFloorPlanToken(l); if (fp) { madori = fp; break; } }
  return { name: head?.propertyName ?? null, roomNo: head?.roomNo || null, rentYen: parseRentFromSummary(s), areaSqm: parseAreaSqm(s), madori };
}

/**
 * 物件ごとの鍵（保存した読み取りを引く）。物件名＋号室＋所在地。名前が一般名・号室も所在地も無い時は null（鍵にしない）。
 * ⚠ PDF の中身のハッシュは鍵にできない（リアプロの PDF は「出力日 2026/09/24 18:00:46」が入り、出し直すたびに変わる）
 * 2026-09-24 反証: 号室が文字層に無い資料では「物件名＋所在地」だけになり、同じ建物の別の型の部屋（1K 21㎡ と 1LDK 30㎡）の
 *   読み取りを使い回す穴があった → 間取りと専有面積も鍵に入れる（同じ棟・同じ型・同じ広さなら図も同じ＝使い回してよい）。
 *   資料が差し替わって間取り・面積が変わった部屋も別の鍵になり、読み直す
 */
export function unitKeyOf(t: Pick<SheetTextFacts, "name" | "roomNo" | "address"> & Partial<Pick<SheetTextFacts, "madori" | "areaSqm">>): string | null {
  const b = buildingKey(nfkc(t.name ?? ""));
  if (!b) return null;
  const room = t.roomNo ? normalizeRoomNo(t.roomNo) : "";
  const addr = nfkc(t.address ?? "").replace(/[\s　・、,\-－ー丁目番地号の]/g, "").toLowerCase();
  if (!room && !addr) return null;
  const madori = t.madori ?? "";
  const area = t.areaSqm != null && Number.isFinite(t.areaSqm) ? t.areaSqm.toFixed(2) : "";
  return `${b}|${room}|${addr}|${madori}|${area}`;
}

// ── 突き合わせ ───────────────────────────────────────────────────────
export type SheetConsistency = { status: "ok" | "要確認"; reasons: string[] };

/**
 * 読んだ間取りと資料の間取りが「同じ部屋の図」として矛盾しないか。
 * 2026-09-24 反証: 1R と 1K（キッチンが居室の中か廊下か）・1DK と 1LDK（DK の広さの定義）は図だけでは取り違えやすく、
 *   正しい物件を「要確認」にしていた → 部屋の数が同じで R/K どうし・DK/LDK どうしなら食い違いにしない（別の部屋の図は帖数・面積で見る）
 */
export function madoriCompatible(read: string, ref: string): boolean {
  if (read === ref) return true;
  const a = read.match(/^([1-9])(R|K|DK|LDK)$/), b = ref.match(/^([1-9])(R|K|DK|LDK)$/);
  if (!a || !b || a[1] !== b[1]) return false;
  const grp = (x: string) => (x === "R" || x === "K" ? "k" : "dk");
  return grp(a[2]) === grp(b[2]);
}

/** 面積の比べ方: 片方が整数（切り捨て・四捨五入の表記）なら 1㎡ 未満、小数どうしは 0.1㎡ 以内を同じと見る */
function sameArea(a: number, b: number): boolean {
  const isInt = (x: number) => Math.abs(x - Math.round(x)) < 1e-9;
  return Math.abs(a - b) < (isInt(a) || isInt(b) ? 1 : 0.1 + 1e-9);
}

/** 読んだ帖数に居室（洋・和）が間取りの数だけあり、DK/LDK の間取りなら DK/LDK の帖数もあるか */
function allMainRoomsRead(readJo: Array<{ kind: string | null }>, madori: string | null): boolean {
  const m = String(madori ?? "").match(/^([1-9])(R|K|DK|LDK)$/);
  if (!m) return false;
  const living = readJo.filter((r) => r.kind === "洋" || r.kind === "和").length;
  const needLiving = m[2] === "R" || m[2] === "K" ? 1 : parseInt(m[1], 10);
  const needDk = m[2] === "DK" || m[2] === "LDK";
  const hasDk = readJo.some((r) => r.kind === "LDK" || r.kind === "DK");
  return living >= needLiving && (!needDk || hasDk);
}

const sameName = (a: string, b: string) => {
  const x = buildingKey(nfkc(a)), y = buildingKey(nfkc(b));
  if (!x || !y) return true;   // 一般名・空は比べない
  return x === y || x.includes(y) || y.includes(x);
};

/**
 * 説明文・文字層・読んだ間取り図が同じ部屋の物かを確かめる。1つでも食い違えば「要確認」（点を出さない）。
 * image は読んだ事実（読んでいない・文字だけで照合する時は null）
 */
export function checkSheetConsistency(input: { summary?: string | null; text: SheetTextFacts; image?: SheetImageFacts | null }): SheetConsistency {
  const reasons: string[] = [];
  const t = input.text;
  const s = input.summary ? parseSummaryFacts(input.summary) : null;
  // ① 説明文と資料（文字層）
  if (s && t.hasText) {
    if (s.name && t.name && !sameName(s.name, t.name)) reasons.push(`物件名が説明文と資料で違う（${s.name}／${t.name}）`);
    if (s.rentYen != null && t.rentYen != null && s.rentYen !== t.rentYen) reasons.push(`賃料が説明文と資料で違う（${s.rentYen.toLocaleString()}円／${t.rentYen.toLocaleString()}円）`);
    if (s.areaSqm != null && t.areaSqm != null && !sameArea(s.areaSqm, t.areaSqm)) reasons.push(`専有面積が説明文と資料で違う（${s.areaSqm}㎡／${t.areaSqm}㎡）`);
    if (s.madori && t.madori && s.madori !== t.madori) reasons.push(`間取りが説明文と資料で違う（${s.madori}／${t.madori}）`);
    if (s.roomNo && t.roomNo && normalizeRoomNo(s.roomNo) !== normalizeRoomNo(t.roomNo)) reasons.push(`号室が説明文と資料で違う（${s.roomNo}／${t.roomNo}）`);
  }
  // ② 資料の中（1ページ目と2ページ目）
  if (t.names.length > 1 && t.names.some((n) => !sameName(n, t.names[0]))) reasons.push(`資料の中で物件名が違う（${t.names.slice(0, 3).join("／")}）`);
  if (t.roomNos.length > 1) reasons.push(`資料の中で号室が違う（${t.roomNos.slice(0, 3).join("／")}）`);
  // ③ 読んだ間取り図
  const img = input.image ?? null;
  if (img) {
    const refMadori = t.madori ?? s?.madori ?? null;
    const refArea = t.areaSqm ?? s?.areaSqm ?? null;
    if (!img.fp_ok) reasons.push(`間取り図が読めない・見当たらない${img.see ? `（${img.see}）` : ""}`);
    if (img.other_unit) reasons.push("図に別の部屋・複数の間取りがある");
    if (img.fp_ok && img.madori && refMadori && !madoriCompatible(img.madori, refMadori)) reasons.push(`読んだ間取り（${img.madori}）が資料の間取り（${refMadori}）と違う`);
    const readJo = img.rooms.filter((r) => r.jo != null).map((r) => ({ kind: roomKindOf(r.name), jo: r.jo as number }));
    if (img.fp_ok && readJo.length > 0) {
      for (const tj of t.jo) {
        if (tj.kind === "K" || tj.kind === "S") continue;
        const cands = readJo.filter((r) => r.kind === tj.kind || (tj.kind === "LDK" && r.kind === "DK"));
        if (cands.length && !cands.some((r) => Math.abs(r.jo - tj.jo) <= JO_TOLERANCE + 1e-9)) {
          reasons.push(`帖数が資料と違う（資料 ${tj.kind}${tj.jo}／図 ${cands.map((r) => r.jo).join("・")}）`);
        }
      }
      // 同じ部屋を2回書いた返事（種類と帖数が同じ）は1回に数える
      const uniq = [...new Map(readJo.map((r, i) => [`${r.kind ?? `?${i}`}|${r.jo}`, r])).values()];
      const sum = uniq.reduce((a, r) => a + r.jo, 0);
      // 上: 帖数の合計×1.62 は壁・水回りを含まないので専有面積より小さいはず。読みの小数の揺れに 3% だけ許す
      if (refArea != null && sum * JO_SQM > refArea * 1.03 + 1e-9) reasons.push(`読んだ帖数の合計（${Math.round(sum * 10) / 10}帖）が専有面積 ${refArea}㎡ より広い（別の部屋の図の可能性）`);
      // 下: 居室の帖数が全部読めた時だけ（2026-09-24 反証: K の帖数だけ読めた 1K を「小さすぎる」で要確認にしていた）
      else if (refArea != null && sum * JO_SQM < refArea * 0.25 && allMainRoomsRead(uniq, img.madori || refMadori)) reasons.push(`読んだ帖数の合計（${Math.round(sum * 10) / 10}帖）が専有面積 ${refArea}㎡ に比べて小さすぎる`);
    }
    if (img.area_sqm != null && refArea != null && Math.abs(img.area_sqm - refArea) > Math.max(1, refArea * 0.05)) {
      reasons.push(`図の中の面積（${img.area_sqm}㎡）が専有面積（${refArea}㎡）と違う`);
    }
  }
  return { status: reasons.length ? "要確認" : "ok", reasons };
}

// ── 希望との照合（文字だけ・決まった手順） ───────────────────────────────────
type Presence = { v: boolean | null; why: string };
const P = (v: boolean | null, why = ""): Presence => ({ v, why });

/**
 * 希望が「嫌」の向きか。ng の印に加えて、文そのものの言い方（「ペット可NG」「〜は嫌」）でも見る。
 * 2026-09-24 YUMA: スタッフのメモ（出どころ「メモ」）の「ペット可NG」は ng の印が付かず、ペット相談の物件が「合う」になった
 */
// 「1階以外」も嫌の向き（2026-09-24 反証: 「以外」を見ておらず、「1階以外」を 1階が欲しいと読んでいた）
const NEG_WORD_RE = /NG|嫌|いや|不可(?!能)|不要|いらない|要らない|避けたい|無し希望|なしで|以外/i;
function wantIsNg(want: ImageWant): boolean {
  return want.ng || NEG_WORD_RE.test(want.text);
}

/** 希望の「向き」（その物が欲しい＝true）。ng と言い方で決める */
function desired(want: ImageWant, flipRe: RegExp | null): boolean {
  const ng = wantIsNg(want);
  const flip = flipRe ? flipRe.test(want.text) : false;
  return flip ? ng : !ng;
}

/** 資料の設備の文にあるか */
const has = (t: SheetTextFacts, re: RegExp) => re.test(t.features);

const WIC_TEXT_RE = /WIC|W\.I\.C|ウォークイン|ウオークイン|WCL|ウォークスルー|納戸/i;

function presenceOf(key: string, want: ImageWant, t: SheetTextFacts, img: SheetImageFacts | null, madori: string | null): Presence {
  const f = t.features.replace(/シューズ\s*(?:WIC|ウォークイン(?:クローゼット)?|クローク)/gi, "SIC");
  switch (key) {
    case "wic":
      if (WIC_TEXT_RE.test(f)) return P(true, "資料の設備: WIC");
      if (img?.storage.wic === "あり") return P(true, "間取り図: WIC あり");
      if (img?.storage.wic === "なし") return P(false, "間取り図: WIC なし");
      return P(null);
    case "shoes_ic":
      if (/SIC|シューズクローク/i.test(f)) return P(true, "資料の設備: シューズクローク");
      return P(null);
    case "storage": {
      const many = /多|たくさん|広|大き|沢山/.test(want.text);
      const wic = WIC_TEXT_RE.test(f) || img?.storage.wic === "あり";
      const closets = img?.storage.closets ?? null;
      if (many) {
        if (wic || (closets != null && closets >= 2)) return P(true, wic ? "WIC あり" : `間取り図: 収納 ${closets}か所`);
        if (closets === 0 && img?.storage.wic === "なし") return P(false, "間取り図: 居室の収納なし");
        return P(null);
      }
      if (wic || (closets != null && closets >= 1) || /クローゼット|クロゼット|物入|押入/.test(f)) return P(true, wic ? "WIC あり" : closets ? `間取り図: 収納 ${closets}か所` : "資料の設備: クローゼット");
      if (closets === 0 && img?.storage.wic === "なし") return P(false, "間取り図: 居室の収納なし");
      return P(null);
    }
    case "counter_kitchen":
      if (/カウンターキッチン|対面(?:式)?キッチン|対面式/.test(f)) return P(true, "資料の設備: カウンターキッチン");
      if (img?.kitchen.placement === "対面") return P(true, "間取り図: 対面");
      if (img?.kitchen.placement === "壁付け" || img?.kitchen.placement === "独立") return P(false, `間取り図: ${img.kitchen.placement}`);
      return P(null);
    case "separate_kitchen":
      if (img?.kitchen.placement === "独立") return P(true, "間取り図: 独立キッチン");
      return P(null);
    case "burners": {
      const n = parseInt(nfkc(want.text).replace(/二/g, "2").replace(/三/g, "3").match(/([23])口/)?.[1] ?? "", 10);
      const m = f.match(/(\d)\s*口(以上)?/);
      const b = m ? parseInt(m[1], 10) : img?.kitchen.burners ?? null;
      if (!Number.isFinite(n) || b == null) return P(null);
      return P(b >= n, `コンロ ${b}口`);
    }
    case "bath_toilet":
      if (/バス[・･]?トイレ別|バストイレ別|風呂[・･]?トイレ別/.test(f)) return P(true, "資料の設備: バス・トイレ別");
      if (/[3三]点ユニット/.test(f)) return P(false, "資料の設備: 3点ユニット");
      if (img?.water.bath_toilet === "別") return P(true, "間取り図: 浴室とトイレが別");
      if (img?.water.bath_toilet === "同室") return P(false, "間取り図: 浴室とトイレが同室");
      return P(null);
    case "washbasin":
      if (/独立洗面|洗面台\s*[（(]独立[)）]|洗面所独立|洗面化粧台\s*[（(]独立/.test(f)) return P(true, "資料の設備: 独立洗面台");
      if (img?.water.washbasin === "独立") return P(true, "間取り図: 独立洗面");
      if (img?.water.washbasin === "浴室内") return P(false, "間取り図: 洗面は浴室内");
      return P(null);
    case "laundry_in":
      if (/洗濯機置場\s*[（(]室内[)）]|室内洗濯機/.test(f)) return P(true, "資料の設備: 洗濯機置場（室内）");
      if (/洗濯機置場\s*[（(](?:屋外|室外|バルコニー|ベランダ)[)）]/.test(f)) return P(false, "資料の設備: 洗濯機置場（屋外）");
      if (img?.water.laundry === "室内") return P(true, "間取り図: 洗濯機置場は室内");
      if (img?.water.laundry === "屋外") return P(false, "間取り図: 洗濯機置場は屋外");
      return P(null);
    case "layout": {
      if (!/分け|別々|分かれ|独立した|仕切|一緒|続き|つなが/.test(want.text)) return P(null);
      const plan = img?.madori || madori;
      if (plan && /^1[RK]$/.test(plan)) return P(false, `${plan}（居室が1つ）`);
      if (img?.living_bedroom === "単室") return P(false, "間取り図: 居室が1つ");
      if (img?.living_bedroom === "廊下を挟む" || img?.living_bedroom === "隣接") return P(true, `間取り図: ${img.living_bedroom}`);
      return P(null);
    }
    case "pet":
      if (/ペット\s*(?:不可|禁止)/.test(f)) return P(false, "資料: ペット不可");
      if (/ペット\s*(?:可|相談|飼育可)|ペット飼育可|小型犬|猫可/.test(f)) return P(true, "資料: ペット可・相談");
      return P(null);
    case "autolock":
      return /オートロック/.test(f) ? P(true, "資料の設備: オートロック") : P(null);
    case "net_free":
      return /ネット使用料不要|インターネット\s*(?:\(Wi-?Fi\))?\s*無料|ネット無料|Wi-?Fi無料|インターネット無料/i.test(f) ? P(true, "資料: ネット無料") : P(null);
    case "delivery_box":
      return /宅配\s*(?:BOX|ボックス)/i.test(f) ? P(true, "資料の設備: 宅配BOX") : P(null);
    case "sunlight": {
      const dir = t.direction;
      if (!dir) return P(null);
      const want1 = nfkc(want.text).match(/([東西南北])向き/)?.[1];
      if (want1) return P(dir.includes(want1), `開口部方位: ${dir}`);
      if (/日当たり|日あたり|採光/.test(want.text)) {
        if (dir.includes("南")) return P(true, `開口部方位: ${dir}`);
        if (dir === "北") return P(false, `開口部方位: ${dir}`);
      }
      return P(null);
    }
    case "corner":
      return /角部屋|角住戸/.test(f) ? P(true, "資料: 角部屋") : P(null);
    case "floor2":
      if (t.floor == null) return P(null);
      return P(t.floor >= 2, `${t.floor}階`);
    case "loft":
      return /ロフト/.test(f) ? P(true, "資料の設備: ロフト") : P(null);
    case "balcony":
      if (/バルコニー|ベランダ/.test(f)) return P(true, "資料の設備: バルコニー");
      if (img?.balcony === "あり") return P(true, "間取り図: バルコニー");
      if (img?.balcony === "なし") return P(false, "間取り図: バルコニーなし");
      return P(null);
  }
  return P(null);
}

/** 「欲しい物」の向きを言い方で反対にする言葉（「3点ユニットNG」はバストイレ別が欲しい／「1階NG」は2階以上が欲しい） */
const FLIP: Record<string, RegExp> = {
  bath_toilet: /ユニット|一緒|同じ|同室/,
  laundry_in: /外|屋外|ベランダ|バルコニー/,
  layout: /一緒|続き|つなが/,
  floor2: /[1１一]階/,
};
/** 希望の言い方が「どちらでもよい」なら照合しない */
const INDIFFERENT_RE = /でも(?:いい|良い|OK|大丈夫|可)|どちらでも|こだわらない/i;

export type FactsMatch = {
  checks: WantCheck[];
  /** 決まった手順に当てはまる設備が無い希望（文字だけで DeepSeek に聞く候補） */
  undecided: string[];
};

/**
 * 保存した事実（文字層＋読んだ間取り図）と希望を決まった手順で照らす。
 * 設備が1つも当たらない希望は undecided（呼び出し側が文字だけで聞く）。設備は当たるが資料で分からない物は unknown
 */
export function matchWantsWithFacts(wants: ImageWant[], text: SheetTextFacts, image: SheetImageFacts | null, summaryMadori?: string | null): FactsMatch {
  const checks: WantCheck[] = [];
  const undecided: string[] = [];
  const madori = text.madori ?? summaryMadori ?? null;
  for (const w of wants) {
    const keys = wantFeatures(w.text);
    if (!keys.length || INDIFFERENT_RE.test(w.text)) { undecided.push(w.id); continue; }
    const results: Array<{ ok: boolean | null; why: string }> = keys.map((k) => {
      const p = presenceOf(k, w, text, image, madori);
      if (p.v == null) return { ok: null, why: "" };
      return { ok: p.v === desired(w, FLIP[k] ?? null), why: p.why };
    });
    const bad = results.find((r) => r.ok === false);
    const known = results.filter((r) => r.ok != null);
    if (bad) checks.push({ id: w.id, result: "ng", why: bad.why });
    else if (known.length === results.length) checks.push({ id: w.id, result: "ok", why: known.map((r) => r.why).filter(Boolean).join("・") });
    else checks.push({ id: w.id, result: "unknown", why: "" });
  }
  return { checks, undecided };
}

// ── 画面に出す短い文（スタッフ向け） ───────────────────────────────────────
export function describeFacts(text: SheetTextFacts, image: SheetImageFacts | null): { water: string; kitchen: string; layout: string; storage: string } {
  const f = text.features;
  const water: string[] = [];
  if (/バス[・･]?トイレ別|バストイレ別/.test(f) || image?.water.bath_toilet === "別") water.push("バス・トイレ別");
  else if (image?.water.bath_toilet === "同室" || /[3三]点ユニット/.test(f)) water.push("3点ユニット");
  if (/独立洗面|洗面台\s*[（(]独立[)）]|洗面所独立/.test(f) || image?.water.washbasin === "独立") water.push("独立洗面台");
  if (/浴室乾燥/.test(f)) water.push("浴室乾燥機");
  if (/追[い]?焚/.test(f)) water.push("追い焚き");
  if (/洗濯機置場\s*[（(]室内[)）]/.test(f) || image?.water.laundry === "室内") water.push("室内洗濯機置場");
  const kitchen: string[] = [];
  // 資料の設備欄の言葉を先に（照合と同じ順）。2026-09-24 YUMA: 設備欄「カウンターキッチン」なのに図の読みの「壁付け」を出し、照合の ◎ と食い違って見えた
  if (/カウンターキッチン|対面(?:式)?キッチン/.test(f)) kitchen.push("カウンターキッチン（資料）");
  else if (image && image.kitchen.placement !== "不明") kitchen.push(image.kitchen.placement);
  if (/IH/.test(f) || image?.kitchen.stove === "IH") kitchen.push("IH");
  else if (/ガスコンロ|ガスキッチン/.test(f) || image?.kitchen.stove === "ガス") kitchen.push("ガス");
  const bm = f.match(/(\d)\s*口(以上)?/);
  if (bm) kitchen.push(`${bm[1]}口${bm[2] ?? ""}`);
  if (/システムキッチン/.test(f)) kitchen.push("システムキッチン");
  const layout: string[] = [];
  const plan = image?.madori || text.madori;
  if (plan) layout.push(plan);
  if (image && image.living_bedroom !== "不明") layout.push(image.living_bedroom);
  const rooms = (image?.rooms ?? []).filter((r) => r.jo != null).map((r) => `${r.name}${r.jo}帖`);
  if (rooms.length) layout.push(rooms.join("・"));
  const storage: string[] = [];
  if (WIC_TEXT_RE.test(f.replace(/シューズ\s*(?:WIC|ウォークイン(?:クローゼット)?|クローク)/gi, "")) || image?.storage.wic === "あり") storage.push("WIC あり");
  if (image?.storage.closets != null) storage.push(`収納 ${image.storage.closets}か所`);
  if (/シューズボックス|下足/.test(f) || image?.storage.shoes === "あり") storage.push("シューズボックス");
  return { water: water.join("・"), kitchen: kitchen.join("・"), layout: layout.join("・"), storage: storage.join("・") };
}
