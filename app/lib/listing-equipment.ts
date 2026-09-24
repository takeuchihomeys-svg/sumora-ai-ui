// app/lib/listing-equipment.ts（純関数・依存は generic-building-name だけ・fs や DB は使わない）
// 物件資料の PDF の文字層（pdf-text の text）から「所在階・階建・設備の有無」を決定論で読み、お客様の設備の希望と照らす。
//
// 2026-09-24 竹内「設備の項目はここに記載ある（資料の『設備』欄）。設備面も見るように。また階数は 202号室なら2階、301号室なら3階等、
//   号室の最初の部分でわかる。プロンプトキャッシュ効かせるようにする」
//
// 実物（property_pickups の pdf_blob_url 36行・itandi 18＋リアプロ 18 の1ページ目の文字層・2026-09-24）:
//   itandi:  上の帯「エステムコート新⼤阪 Ⅵ エキスプレイス 405 号室」・表「所在階 4 階 主要採光⾯ ⻄向き」
//            「構造 鉄筋コンクリート 階建 / 総⼾数 15 階建 / 180 ⼾」「駐⾞場 空きなし 敷地内 駐⾞場代 なし」
//            見出し「設備」の下に「都市ガス , バス‧トイレ別 , 独⽴洗⾯台 , 室内\n洗濯機置場 , … , 宅配 BOX, …」、続けて「備考」
//            → 康熙部首（⽴⾯⾓）・「‧」・「宅配 BOX」の空白・行をまたいだ語（「シ\nステムキッチン」）がある
//   リアプロ: 「物件名 X」「号室名 0901（9階部分）」「建築構造 鉄筋コンクリート造 地上10階」「開口部方位 東」
//            見出し「備 考」「設 備」「条 件」（字の間に空白）→ 「取引態様」「特記事項」で終わる
//            揺れ: 「エレベータ 各階有」「2F以上」「角住戸(角地)」「洗面台（独立）」「洗面所独立」「風呂（ユニットバス）」と「バス・トイレ別」が
//            両方ある（ユニットバス＝浴槽の型で、3点ユニットではない）・「オ\nートロック」「洗濯機置場（\n室内）」
//            駐車場は2段組で値が「町内会費」とずれる（「なし 駐車場」はどちらの値か決まらない）→ 「駐車場／空きなし」「駐車場:設備なし」
//            「駐車場情報:なし」のように言葉がくっ付いている時だけ読む
// 決まり（誤って ng にしない側に倒す）:
//   - ng は「はっきり書いてある時だけ」: 所在階 1階・地下／ペット不可／3点ユニット／洗濯機置場（屋外）／駐車場 空きなし・なし／単身限定／
//     エレベーターなし／木造（構造欄）／採光面が南を含まない（向きの欄）／オール電化（ガスコンロ）
//   - 書いていない物は unlisted（無いとは限らない）。3階建でエレベーターが書いていなくても ng にしない
//   - 読む範囲は itandi＝設備・備考、リアプロ＝備考・設備・条件（特記事項・保証会社の文は入れない＝「ペット飼育時は…」で当てない）。
//     階・階建・向き・構造・駐車場は表の欄から読む
//   - 設備と階は文字層から決定論で決め、DeepSeek は呼ばない（費用 0）。文字で決まらない希望だけを後で聞く時のために、
//     固定の前置き（変わらない指示を先頭・物件ごとの文字を後ろ）を buildEquipmentAskPrompt で作る（呼び出しはまだ無い）

// 依存は generic-building-name（純関数）だけ
import { isGenericBuildingName } from "./generic-building-name";

// ───────────────────────── 正規化 ─────────────────────────

/** CJK 部首補助（U+2E80〜）は NFKC で直らない（itandi の「⻄」）→ よく出る字だけ置き換える */
const RADICAL_SUPPLEMENT: Record<string, string> = {
  "⻄": "西", "⻑": "長", "⻘": "青", "⻝": "食", "⻤": "鬼", "⻩": "黄", "⻫": "斉", "⻭": "歯", "⻯": "竜", "⻲": "亀", "⻨": "麦",
};
function norm(raw: string | null | undefined): string {
  return String(raw ?? "").normalize("NFKC").replace(/[⺀-⻿]/g, (c) => RADICAL_SUPPLEMENT[c] ?? c)
    .replace(/[‧･]/g, "・").replace(/\r/g, "").replace(/[ \t]+/g, " ");
}
/** 空白・改行を全部外す（行をまたいで割れた語「オ\nートロック」・「宅配 BOX」を1語にする） */
const squash = (s: string) => s.replace(/\s+/g, "");
const KANJI_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function toNum(s: string): number | null {
  const t = s.normalize("NFKC");
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (/^[一二三四五六七八九十]+$/.test(t)) {
    if (t === "十") return 10;
    if (t.length === 2 && t[0] === "十") return 10 + (KANJI_NUM[t[1]] ?? 0);
    if (t.length === 1) return KANJI_NUM[t] ?? null;
  }
  return null;
}

// ───────────────────────── 号室 → 階 ─────────────────────────

/**
 * 号室から階を推す。「202」→2・「301」→3・「1001」→10・「0901」→9・「1512」→15・「405」→4・「3A」→3・「3F」「1F-2」→ F の前。
 * 3桁以上の数字は下2桁が部屋番号・残りが階。2桁（「12」）は決められない（null）。地下（「B101」「地下1」）は null（別扱い）。
 * 「A棟301」「A-301」は棟の印を外して読む（「B101」の B は地下の印なので外さない）。
 */
export function floorFromRoom(room: string | null | undefined): number | null {
  let s = String(room ?? "").normalize("NFKC").trim().replace(/\s+/g, "").replace(/号室?$/, "").replace(/[（(].*$/, "");
  if (!s) return null;
  if (/地下/.test(s)) return null;
  if (/棟/.test(s)) s = s.replace(/^.*棟[-ー]?/, "");
  else if (/^B-?\d/i.test(s)) return null; // 地下
  const f = s.match(/^(\d{1,2})F/i);
  if (f) { const n = parseInt(f[1], 10); return n >= 1 ? n : null; }
  s = s.replace(/^[A-Za-z]+[-ー]?(?=\d{3})/, "");
  const alpha = s.match(/^(\d{1,2})[A-Za-z]$/);
  if (alpha) { const n = parseInt(alpha[1], 10); return n >= 1 ? n : null; }
  const d = s.match(/^(\d{3,5})$/);
  if (!d) return null;
  const n = parseInt(d[1].slice(0, -2), 10);
  return n >= 1 && n <= 60 ? n : null;
}

/** 号室が地下の印か（「B101」「B-02」「地下1」） */
export function isBasementRoom(room: string | null | undefined): boolean {
  const s = String(room ?? "").normalize("NFKC").trim();
  return /地下/.test(s) || (/^B-?\d/i.test(s) && !/棟/.test(s));
}

// ───────────────────────── 設備のキー ─────────────────────────

export type EquipKey =
  | "elevator" | "delivery_box" | "autolock" | "net_free" | "parking"
  | "bath_toilet" | "washbasin" | "laundry_in" | "corner" | "pet" | "floor2" | "top_floor" | "south"
  | "aircon" | "system_kitchen" | "counter_kitchen" | "reheating" | "bath_dryer" | "washlet"
  | "walk_in_closet" | "shoebox" | "monitor_intercom" | "city_gas" | "gas_stove" | "ih" | "burner2"
  | "flooring" | "balcony" | "loft" | "bike_parking" | "garbage24" | "two_person" | "no_guarantor" | "rc" | "not_wood";

/** 表示の短い名前 */
export const EQUIP_LABELS: Record<EquipKey, string> = {
  elevator: "エレベーター", delivery_box: "宅配ボックス", autolock: "オートロック", net_free: "ネット無料", parking: "駐車場",
  bath_toilet: "バス・トイレ別", washbasin: "独立洗面台", laundry_in: "室内洗濯機置場", corner: "角部屋", pet: "ペット",
  floor2: "2階以上", top_floor: "最上階", south: "南向き", aircon: "エアコン", system_kitchen: "システムキッチン",
  counter_kitchen: "対面キッチン", reheating: "追い焚き", bath_dryer: "浴室乾燥機", washlet: "温水洗浄便座",
  walk_in_closet: "WIC", shoebox: "シューズボックス", monitor_intercom: "モニター付インターホン", city_gas: "都市ガス",
  gas_stove: "ガスコンロ", ih: "IHコンロ", burner2: "コンロ2口以上", flooring: "フローリング", balcony: "バルコニー", loft: "ロフト",
  bike_parking: "駐輪場", garbage24: "24時間ゴミ出し", two_person: "二人入居可", no_guarantor: "保証人不要",
  rc: "鉄筋コンクリート", not_wood: "木造以外",
};
export const EQUIP_KEYS = Object.keys(EQUIP_LABELS) as EquipKey[];

/**
 * 建物単位の設備（同じ建物の別の部屋の資料に書いてあれば補ってよい物）。竹内さんの指定どおりこの5つだけ。
 * 部屋単位（バス・トイレ別・独立洗面・角部屋・階・向き・ペットの条件）は部屋ごとに違うので補わない。
 */
export const BUILDING_KEYS: EquipKey[] = ["elevator", "delivery_box", "autolock", "net_free", "parking"];

export type EquipStatus = "ok" | "ng" | "unlisted";
export type EquipFact = {
  status: EquipStatus;
  /** 根拠の文字（資料の文字そのまま・空白は詰めてある） */
  evidence: string | null;
  /** ペット「可/相談/不可」・駐車場「空きあり/あり/近隣/空きなし/なし」 */
  detail?: string;
  /** 同じ建物の別の部屋の資料から補った */
  fromBuilding?: boolean;
  /** unlisted だが近い言葉があった（「洗髪洗面化粧台（独立の記載なし）」） */
  hint?: string;
};

export type ListingEquipment = {
  format: "itandi" | "realpro" | "unknown";
  hasText: boolean;
  name: string | null;
  room: string | null;
  /**
   * 同じ建物の鍵（物件名を詰めて小文字。一般名「物件」「マンション」は使わない。名前が無ければ番地まである所在地「@…」。
   * 番地の無い所在地（「中央4丁目」）は同じ丁目の別の建物と重なるので鍵にしない＝補わない）
   */
  buildingKey: string | null;
  /** 番地まである所在地の鍵（名前が同じでも所在地が食い違えば別の建物として補わない）。無ければ null */
  addressKey?: string | null;
  floor: number | null;
  floorSource: "所在階" | "階部分" | "号室" | null;
  /** 号室から推した階（突き合わせ用。表の階と違えば監査で見る） */
  roomFloor: number | null;
  basement: boolean;
  totalFloors: number | null;
  structure: string | null;
  direction: string | null;
  items: Record<EquipKey, EquipFact>;
};

/** ok が1つでも当たれば ok（ng より先に見る＝矛盾する記載では ng にしない） */
type Rule = { ok?: RegExp[]; ng?: RegExp[] };
// 照らす文字は空白・改行を詰めた物（squash 済み）
const RULES: Partial<Record<EquipKey, Rule>> = {
  elevator: { ok: [/エレベータ[ー]?(?:[（(][^)）]{0,6}[)）]|各階有)?/], ng: [/エレベータ[ー]?(?:なし|無し|無)(?![料])/] },
  delivery_box: { ok: [/宅配(?:BOX|ボックス|ロッカー)(?:暗証番号)?/i], ng: [/宅配(?:BOX|ボックス)(?:なし|無し)/i] },
  autolock: { ok: [/(?:モニタ付)?オートロック/], ng: [/オートロック(?:なし|無し)/] },
  net_free: { ok: [/インターネット(?:\(Wi-?Fi\))?(?:使用料)?無料|ネット使用料(?:不要|無料)|ネット無料|無料インターネット|Wi-?Fi無料/i] },
  bath_toilet: {
    ok: [/バス・?トイレ別|風呂・?トイレ別|バストイレ別|トイレ・?バス別|セパレート/],
    ng: [/3点ユニット|3点式ユニット|バス・?トイレ(?:一緒|同室)|トイレ同室/],
  },
  washbasin: { ok: [/独立洗面(?:台|所|化粧台)?|洗面台[（(]独立[)）]|洗面所独立|洗面(?:所|台)が独立/], ng: [/独立洗面台?(?:なし|無し)/] },
  laundry_in: {
    ok: [/室内洗濯機置き?場|洗濯機置き?場[（(]室内[)）]|室内洗濯機/],
    ng: [/洗濯機置き?場[（(](?:屋外|室外|ベランダ|バルコニー|外)[)）]|(?:屋外|室外|ベランダ|バルコニー)洗濯機置き?場|洗濯機置き?場(?:なし|無し)/],
  },
  corner: { ok: [/角部屋|角住戸(?:\([^)]{0,4}\))?/] },
  aircon: { ok: [/エアコン(?:[（(][^)）]{0,6}[)）])?|冷暖房(?:全室設置済|完備)/], ng: [/エアコン(?:なし|無し)/] },
  system_kitchen: { ok: [/システムキッチン/] },
  counter_kitchen: { ok: [/カウンターキッチン|対面(?:式)?キッチン/] },
  reheating: { ok: [/追い?[焚炊]き?(?:機能|風呂)?/] },
  bath_dryer: { ok: [/浴室(?:換気)?乾燥機?|浴室暖房/] },
  washlet: { ok: [/温水洗浄(?:暖房)?便座|シャワートイレ|ウォシュレット/] },
  walk_in_closet: { ok: [/(?<!シューズ)(?:ウォークイン(?:クロー?ゼット|クロゼット)?|ウォークスルー(?:クロー?ゼット)?|W\.?I\.?C(?![A-Z])|WCL)/i] },
  shoebox: { ok: [/シューズ(?:ボックス|BOX|ウォークイン(?:クロー?ゼット|クロゼット)?|クローク|イン(?:クローゼット)?)|下駄箱|(?<![A-Z])SIC(?![A-Z])/i] },
  monitor_intercom: { ok: [/モニタ[ー]?付(?:き)?(?:インターホン|オートロック)|インターホン[（(]カメラ付き?[)）]|TVモニタ[ー]?付|カメラ付(?:き)?インターホン/] },
  city_gas: { ok: [/都市ガス/], ng: [/プロパンガス|LPガス|プロパン/] },
  gas_stove: { ok: [/ガスコンロ|ガスキッチン/], ng: [/オール電化/] },
  ih: { ok: [/IH(?:クッキングヒーター|コンロ)?(?:[（(][^)）]{0,6}[)）])?|クッキングヒーター/] },
  burner2: { ok: [/(?:[2-9]|二|三)口(?:コンロ|以上)?|IHクッキングヒーター[（(](?:[2-9]|二|三)口[^)）]{0,3}[)）]/], ng: [/(?<![0-9])(?:1|一)口コンロ/] },
  flooring: { ok: [/フローリング/] },
  balcony: { ok: [/バルコニー(?:\/ベランダ)?|ベランダ/] },
  loft: { ok: [/ロフト/] },
  bike_parking: { ok: [/駐輪場|自転車置場|バイク置き?場|オートバイ駐輪場/] },
  garbage24: { ok: [/24時間ゴミ出し(?:可)?/] },
  two_person: { ok: [/(?:二|2)人入居(?:可能?)?/], ng: [/単身(?:者)?限定|(?:二|2)人入居不可/] },
  no_guarantor: { ok: [/(?:連帯)?保証人(?:不要|なし可)/] },
};

function firstMatch(text: string, res: RegExp[] | undefined): string | null {
  for (const re of res ?? []) { const m = text.match(re); if (m && m[0]) return m[0]; }
  return null;
}

/** 見出しだけの行（「設 備」のように字間が空いても良い）の位置 */
function headingIndex(text: string, label: string): number {
  const re = new RegExp(`(?:^|\\n)[ \\t]*${label.split("").join("[ \\t]*")}[ \\t]*(?=\\n|$)`);
  const m = re.exec(text);
  return m ? m.index : -1;
}

function detectFormat(text: string): ListingEquipment["format"] {
  if (/RealNetPro|号室名|物件名 /.test(text)) return "realpro";
  if (/所在階|主要採光面/.test(text)) return "itandi";
  return "unknown";
}

/** 設備を読む範囲（itandi＝設備〜備考の終わり・リアプロ＝備考〜条件の終わり）。見出しが無ければ全文 */
function equipmentScope(text: string, format: ListingEquipment["format"]): string {
  if (format === "realpro") {
    const starts = ["備考", "設備", "条件"].map((l) => headingIndex(text, l)).filter((x) => x >= 0);
    if (!starts.length) return text;
    const s = Math.min(...starts);
    const ends = [text.indexOf("取引態様", s), text.indexOf("特記事項", s)].filter((x) => x > s);
    return text.slice(s, ends.length ? Math.min(...ends) : undefined);
  }
  if (format === "itandi") {
    const s = headingIndex(text, "設備");
    return s >= 0 ? text.slice(s) : text;
  }
  return text;
}

const emptyItems = (): Record<EquipKey, EquipFact> =>
  Object.fromEntries(EQUIP_KEYS.map((k) => [k, { status: "unlisted", evidence: null } as EquipFact])) as Record<EquipKey, EquipFact>;

/** 所在地が番地まであるか（「1丁目 7-46」「1-7-46」「12番地」）。丁目・町名だけは同じ所に別の建物が並ぶので false */
function hasBanchi(addr: string): boolean {
  const s = norm(addr).replace(/\s+/g, "");
  return /丁目\d+|\d+[-‐−－ー]\d+|\d+番/.test(s);
}

/** 物件名を建物の鍵に（空白・記号を外して小文字・NFKC で Ⅵ→VI） */
export function buildingKeyOf(name: string | null | undefined): string | null {
  const s = norm(name).replace(/[\s　★☆◆◇■□●○※()（）「」・,.'’\-ー]/g, "").toLowerCase();
  return s.length >= 2 ? s : null;
}

/**
 * 資料の文字層から 所在階・階建・設備の有無 を読む（決定論・投げない）。
 * 所在階は itandi「所在階 N 階」→ リアプロ「（N階部分）」→ 号室から推す の順（floorSource に出どころ）。
 */
export function parseListingEquipment(raw: string | null | undefined): ListingEquipment {
  const text = norm(raw);
  const format = detectFormat(text);
  const items = emptyItems();
  const out: ListingEquipment = {
    format, hasText: text.trim().length >= 40, name: null, room: null, buildingKey: null, floor: null, floorSource: null, roomFloor: null,
    basement: false, totalFloors: null, structure: null, direction: null, items,
  };
  if (!out.hasText) return out;

  // ── 物件名・号室
  if (format === "realpro") {
    out.name = (text.match(/物件名[ \t]+([^\n]+)/) ?? [])[1]?.trim() ?? null;
    const rl = (text.match(/号室名[ \t]+([^\n]+)/) ?? [])[1] ?? "";
    out.room = (rl.match(/^([0-9A-Za-z\-]+)/) ?? [])[1] ?? null;
  } else {
    for (const line of text.split("\n")) {
      const m = line.trim().match(/^(.+?)\s+([0-9A-Za-z\-]{1,8})\s*号室\s*$/);
      if (m) { out.name = m[1].trim(); out.room = m[2]; break; }
    }
  }
  // 2026-09-24 反証レビュー: 一般名（「物件」等）や番地の無い所在地を鍵にすると、同じ回の別の建物に「○〔建〕」を補ってしまう
  //   → 一般名は鍵にしない・所在地は番地（「1丁目 7-46」「12番」）まである時だけ（迷う物は補わない側）
  const addr = (text.match(/所在地[ \t]*\n?[ \t]*([^\n]+)/) ?? [])[1] ?? null;
  out.addressKey = addr && hasBanchi(addr) ? buildingKeyOf(addr) : null;
  const nameKey = out.name && !isGenericBuildingName(out.name) ? buildingKeyOf(out.name) : null;
  out.buildingKey = nameKey ?? (out.addressKey ? `@${out.addressKey}` : null);

  // ── 階
  out.roomFloor = floorFromRoom(out.room);
  out.basement = isBasementRoom(out.room);
  const itFloor = text.match(/所在階[ \t]*(?:地下[ \t]*)?(\d{1,2})[ \t]*階/);
  const rpFloor = text.match(/[（(][ \t]*(地下)?[ \t]*(\d{1,2})[ \t]*階部分[ \t]*[)）]/);
  if (itFloor) { out.floor = parseInt(itFloor[1], 10); out.floorSource = "所在階"; if (/所在階[ \t]*地下/.test(text)) { out.basement = true; out.floor = null; } }
  else if (rpFloor) { if (rpFloor[1]) { out.basement = true; } else { out.floor = parseInt(rpFloor[2], 10); } out.floorSource = "階部分"; }
  else if (out.roomFloor != null) { out.floor = out.roomFloor; out.floorSource = "号室"; }
  const tf = text.match(/地上[ \t]*(\d{1,2})[ \t]*階/) ?? text.match(/総戸数[ \t]*(\d{1,2})[ \t]*階建/) ?? text.match(/(\d{1,2})[ \t]*階建/);
  out.totalFloors = tf ? parseInt(tf[1], 10) : null;

  // ── 構造・向き
  const st = format === "realpro" ? (text.match(/建築構造[ \t]+([^ \t\n]+)/) ?? [])[1] : (text.match(/(?:^|\n)[ \t]*構造[ \t]+([^ \t\n]+)/) ?? [])[1];
  out.structure = st && st !== "ー" && st !== "-" ? st : null;
  const dir = (text.match(/主要採光面[ \t]+([東西南北]{1,2})向き/) ?? text.match(/開口部方位[ \t]+([東西南北]{1,2})(?=[ \t]*(?:\n|$))/) ?? [])[1] ?? null;
  out.direction = dir;

  // ── 設備（範囲の文字を詰めて照らす）
  const scope = squash(equipmentScope(text, format));
  for (const [key, rule] of Object.entries(RULES) as Array<[EquipKey, Rule]>) {
    const ok = firstMatch(scope, rule.ok);
    if (ok) { items[key] = { status: "ok", evidence: ok }; continue; }
    const ng = firstMatch(scope, rule.ng);
    if (ng) items[key] = { status: "ng", evidence: ng };
  }
  // 独立洗面: 「洗髪洗面化粧台」「三面鏡付洗面化粧台」は独立とは書いていない → unlisted のまま手がかりだけ残す
  if (items.washbasin.status === "unlisted") {
    const h = scope.match(/(?:洗髪|三面鏡付き?)?洗面化粧台|シャンプードレッサー/);
    if (h) items.washbasin.hint = `${h[0]}（独立の記載なし）`;
  }
  // 室内洗濯機置場: 場所の無い「洗濯機置場」だけ → unlisted（手がかり）
  if (items.laundry_in.status === "unlisted") {
    const h = scope.match(/洗濯機置き?場/);
    if (h) items.laundry_in.hint = "洗濯機置場（室内か記載なし）";
  }
  // バス・トイレ別: 「風呂（ユニットバス）」は浴槽の型。3点ユニットとは読まない（手がかりにも出さない）

  // ペット（可 > 相談 > 不可。ok が1つでもあれば ng にしない）
  const petOk = scope.match(/ペット(?:飼育)?(?:可能?|OK)(?![否])|(?:小型犬|犬|猫)[^,・不]{0,10}(?:飼育)?(?<!不)可(?![否])/);
  const petAsk = scope.match(/ペット(?:飼育)?(?:相談(?:可)?|対応)/);
  const petNg = scope.match(/ペット(?:飼育)?(?:不可|禁止|NG|×)/);
  if (petOk) items.pet = { status: "ok", evidence: petOk[0], detail: "可" };
  else if (petAsk) items.pet = { status: "ok", evidence: petAsk[0], detail: "相談" };
  else if (petNg) items.pet = { status: "ng", evidence: petNg[0], detail: "不可" };

  // 駐車場（表の欄）。itandi「駐車場 空きなし 敷地内 駐車場代 なし」・リアプロ「敷地内駐車場／空きなし」「駐車場:設備なし」「駐車場情報:なし」
  const flat = squash(text);
  const itP = format === "itandi" ? flat.match(/駐車場(空きあり|空きなし|あり|有|なし|無)(?:敷地内|敷地外|近隣)?駐車場代/) : null;
  const rpP = flat.match(/((?:敷地内|敷地外|近隣)駐車場[\/／](?:空きあり|空有|空きなし|空無|なし))|(駐車場(?:情報)?[:：](?:設備なし|設備あり|なし|無し|あり|有|空きあり|空きなし))/);
  const pTok = itP ? `駐車場${itP[1]}` : rpP ? rpP[0] : null;
  if (pTok) {
    if (/空きなし|空無/.test(pTok)) items.parking = { status: "ng", evidence: pTok, detail: "空きなし" };
    else if (/(?:[:：]|駐車場)(?:設備)?(?:なし|無し?)$|情報[:：]なし/.test(pTok)) items.parking = { status: "ng", evidence: pTok, detail: "なし" };
    else if (/空きあり|空有/.test(pTok)) items.parking = { status: "ok", evidence: pTok, detail: /近隣|敷地外/.test(pTok) ? "近隣" : "空きあり" };
    else if (/あり|有/.test(pTok)) items.parking = { status: "ok", evidence: pTok, detail: "あり" };
  }

  // 階から決まる物
  if (out.basement) items.floor2 = { status: "ng", evidence: `号室 ${out.room ?? ""}（地下）` };
  else if (out.floor != null) {
    const ev = out.floorSource === "所在階" ? `所在階 ${out.floor}階` : out.floorSource === "階部分" ? `${out.floor}階部分` : `号室 ${out.room}（${out.floor}階と推定）`;
    items.floor2 = { status: out.floor >= 2 ? "ok" : "ng", evidence: ev };
  } else {
    const f2 = scope.match(/2F以上|2階以上/);
    if (f2) items.floor2 = { status: "ok", evidence: f2[0] };
  }
  const top = scope.match(/最上階|上階無し/);
  if (top) items.top_floor = { status: "ok", evidence: top[0] };
  else if (out.floor != null && out.totalFloors != null) {
    items.top_floor = out.floor >= out.totalFloors
      ? { status: "ok", evidence: `${out.floor}階／${out.totalFloors}階建` }
      : { status: "ng", evidence: `${out.floor}階／${out.totalFloors}階建` };
  }

  // 向き（欄に向きがある時だけ ng を出せる）
  if (out.direction) items.south = { status: out.direction.includes("南") ? "ok" : "ng", evidence: format === "itandi" ? `主要採光面 ${out.direction}向き` : `開口部方位 ${out.direction}` };
  else { const s = scope.match(/南向き|南面/); if (s) items.south = { status: "ok", evidence: s[0] }; }

  // 構造
  if (out.structure) {
    const s = out.structure;
    const isRc = /鉄筋コンクリート|RC|SRC|鉄骨鉄筋/.test(s);
    const isWood = /木造/.test(s);
    items.rc = { status: isRc ? "ok" : (isWood || /鉄骨|軽量/.test(s)) ? "ng" : "unlisted", evidence: `構造 ${s}` };
    items.not_wood = { status: isWood ? "ng" : "ok", evidence: `構造 ${s}` };
  }
  return out;
}

// ───────────────────────── 同じ建物で補う ─────────────────────────

/**
 * 同じ建物（buildingKey が同じ）の別の部屋の資料に書いてある 建物単位の設備（BUILDING_KEYS）を、unlisted の部屋に「ok〔建〕」で補う。
 * ok だけを補う（ng は補わない＝駐車場の空きは時期で変わる・誤って ng にしない側）。部屋単位の設備は補わない。
 * 入力の並びのまま、新しい物を返す（元は書き換えない）。
 */
export function mergeBuildingEquipment<T extends { id?: string | number | null; facts: ListingEquipment }>(rows: T[]): T[] {
  const byBuilding = new Map<string, T[]>();
  for (const r of rows) {
    const k = r.facts.buildingKey;
    if (!k) continue;
    byBuilding.set(k, [...(byBuilding.get(k) ?? []), r]);
  }
  return rows.map((r) => {
    const k = r.facts.buildingKey;
    // 名前が同じでも、両方に番地まである所在地が食い違えば別の建物（同名の別の建物に補わない）
    const a = r.facts.addressKey ?? null;
    const sibs = k ? (byBuilding.get(k) ?? []).filter((x) => x !== r && !(a && x.facts.addressKey && x.facts.addressKey !== a)) : [];
    if (!sibs.length) return r;
    const items = { ...r.facts.items };
    let changed = false;
    for (const key of BUILDING_KEYS) {
      if (items[key].status !== "unlisted") continue;
      const src = sibs.find((s) => s.facts.items[key].status === "ok" && !s.facts.items[key].fromBuilding);
      if (!src) continue;
      const f = src.facts.items[key];
      items[key] = { status: "ok", evidence: `同じ建物の別の部屋${src.id != null ? `（${typeof src.id === "number" ? `#${src.id}` : src.id}${src.facts.room ? `・${src.facts.room}号室` : ""}）` : ""}: ${f.evidence ?? ""}`, detail: f.detail, fromBuilding: true };
      changed = true;
    }
    return changed ? { ...r, facts: { ...r.facts, items } } : r;
  });
}

// ───────────────────────── お客様の希望 ─────────────────────────

export type WantField = "preferences" | "ng_points" | "other_requests" | "additional_conditions" | "pet";
export type EquipmentWant = {
  /** floor＝「3階以上」「7階以下」のように 2階以上 以外の階の範囲 */
  key: EquipKey | "floor";
  /** must＝あってほしい・ng＝あってほしくない（「ペット可NG」「ロフトNG」） */
  mode: "must" | "ng";
  /** 必須・絶対・マスト */
  strong: boolean;
  /** できれば・あれば・嬉しい */
  soft: boolean;
  minFloor?: number;
  maxFloor?: number;
  /** 元の節 */
  text: string;
  field: WantField;
};
export type EquipmentWants = {
  wants: EquipmentWant[];
  /** どのキーにも当たらない部屋・建物の条件（後で文字で聞く候補） */
  uncovered: Array<{ text: string; field: WantField }>;
  /** 家賃・初期費用・築年・エリア・駅・間取り・㎡・審査など、別の所（property-brain）で見る条件 */
  handledElsewhere: Array<{ text: string; field: WantField }>;
  /** 部屋の条件でも別の所の条件でもない（地名だけ・メモ・お客様の事情・「ペットなし」のような自分の話） */
  other: Array<{ text: string; field: WantField }>;
};
export type CustomerConditionsLike = {
  preferences?: string | null; ng_points?: string | null; other_requests?: string | null; additional_conditions?: string | null; pet?: unknown;
};

/** 希望の文 → キー（1つの節に複数当たってよい）。ng 反転の言い方（1階NG・3点ユニットNG・木造NG）は must として別に扱う */
const WANT_RES: Array<{ key: EquipKey; re: RegExp }> = [
  { key: "elevator", re: /エレベータ[ー]?|EV(?:付|あり)/i },
  { key: "delivery_box", re: /宅配(?:BOX|ボックス|ロッカー)?/i },
  { key: "autolock", re: /オートロック/ },
  { key: "net_free", re: /(?:インター)?ネット(?:使用料)?(?:無料|込|不要)|Wi-?Fi(?:あり|無料|付き?)?|無料(?:インター)?ネット/i },
  { key: "parking", re: /駐車場|駐車(?:スペース)?/ },
  { key: "bath_toilet", re: /(?:バス|お?風呂|浴室)(?:場)?.{0,3}トイレ.{0,4}別|トイレ.{0,4}(?:バス|お?風呂|浴室).{0,4}別|トイレ(?:が|は)?別|バストイレ別|セパレート/ },
  { key: "washbasin", re: /独立洗面|洗面(?:所|台)?(?:が|は)?(?:独立|別)|洗面別/ },
  { key: "laundry_in", re: /室内洗濯|洗濯機(?:置き?場)?(?:が|は)?(?:室内|屋内|洗面所|中)|洗濯機置き?場[（(]室内/ },
  { key: "corner", re: /角部屋|角住戸/ },
  { key: "pet", re: /ペット|(?:小型|中型|大型)?犬|猫|ねこ|いぬ|ポメラニアン|コーギー|トイプードル|チワワ/ },
  { key: "top_floor", re: /最上階/ },
  { key: "south", re: /南向き|南側/ },
  { key: "aircon", re: /エアコン|冷暖房/ },
  { key: "system_kitchen", re: /システムキッチン/ },
  { key: "counter_kitchen", re: /カウンターキッチン|対面(?:式)?(?:キッチン)?/ },
  { key: "reheating", re: /追い?[焚炊]き?/ },
  { key: "bath_dryer", re: /浴室(?:換気)?乾燥|浴室暖房/ },
  { key: "washlet", re: /温水洗浄|ウォシュレット|シャワートイレ/ },
  { key: "walk_in_closet", re: /(?<!シューズ)(?:ウォークイン|ウォークスルー|WIC|W\.I\.C)/i },
  { key: "shoebox", re: /シューズ(?:ボックス|BOX|クローク|イン)|下駄箱/i },
  { key: "monitor_intercom", re: /モニタ[ー]?付|モニター?インターホン|カメラ付(?:き)?インターホン/ },
  { key: "city_gas", re: /都市ガス/ },
  { key: "gas_stove", re: /ガスコンロ/ },
  { key: "ih", re: /IH/ },
  { key: "burner2", re: /(?:[2-9２-９]|二|三)口/ },
  { key: "flooring", re: /フローリング/ },
  { key: "balcony", re: /バルコニー|ベランダ/ },
  { key: "loft", re: /ロフト/ },
  { key: "bike_parking", re: /駐輪|自転車置|バイク置/ },
  { key: "garbage24", re: /24時間ゴミ/ },
  { key: "two_person", re: /(?:二|2|２)人入居|入居(?:二|2|２)人|同棲(?!相手)|(?:二|2|２)人暮らし|(?:二|2|２)人で住/ },
  { key: "no_guarantor", re: /保証人(?:不要|なし|無し|無)/ },
  { key: "rc", re: /鉄筋(?:コンクリート)?|RC造|SRC/ },
];
/** キーの直後にこれがあれば「要らない」（ng）。「保証人不要」「ネット使用料不要」はキー自体に含むので当たらない */
const AFTER_NG_RE = /^(?:は|が)?(?:NG|ng|不可|嫌|いや|避け|いらない|要らない|なしで|無しで|×)/;
const STRONG_RE = /必須|絶対|マスト|\[必須\]/;
const SOFT_RE = /できれば|出来れば|あれば|あったら|嬉しい|うれしい|理想|なるべく|できたら|出来たら|優先|or|または|もしくは/;
/** 「ペットなし」「ペット飼育なし」「ペットなし対応可能」＝お客様がペットを飼っていない話（希望ではない） */
const PET_SELF_NONE_RE = /ペット(?:飼育)?(?:は|が)?(?:なし|無し|無|いない|いません|飼っていない|飼わない)/;
/** ng_points の「Xなし」「X無」＝「X が無いのは NG」＝X が欲しい（must に反転） */
const NG_FIELD_NONE_RE = /^(?:が|は)?(?:なし|無し|無い|ない|無)(?![料])/;
const ACCEPT_ONLY_RE = /ユニットバス(?:でも)?(?:可|OK|大丈夫)|3点ユニット(?:でも)?(?:可|OK|大丈夫)/;
/** 別の所（property-brain）で見る条件（家賃・費用・築年・綺麗さ・場所・間取りの型・㎡・審査・入居・契約・保証） */
const ELSEWHERE_RE = /家賃|賃料|[0-9０-９.]+万|円|初期費用|費用|敷金|礼金|敷礼|更新料|保証料|フリーレント|築|新し|新築|リノベ|リフォーム|綺麗|きれい|キレイ|駅|徒歩|分以内|電車|通勤|職場|エリア|沿線|丁目|周辺|付近|近く|近い|間取り|[1-5１-５]\s*(?:S?LDK|DK|K|R)(?![a-z])|ワンルーム|平米|㎡|m2|審査|保証会社|保証人|ブラック|滞納|破産|任意整理|入居(?:時期|日)|契約|法人|生活保護|社宅|引越|安|抑え|おさえ|下げ|値下げ|管理費|共益費|相場|スモラ割引/;
/** 条件ではないメモ・やり取り（「確認したい」「TikTok で出ている物件」「候補を見たい」）→ other */
const META_RE = /確認したい|TikTok|インスタ|候補|検索|新着|連絡|評価|検討|相談しながら|視野|退去予定|申込|紹介/;
/** 部屋・建物の条件の言葉（キーに当たらなければ uncovered＝後で文字で聞く候補） */
const ROOMISH_RE = /部屋|室|内装|収納|クロー?ゼット|防音|音|和室|洋室|リビング|寝室|庭|家具|家電|デザイナーズ|設備|キッチン|コンロ|シンク|浴槽|風呂|トイレ|洗面|脱衣|洗濯|冷蔵庫|床|窓|日当たり|眺望|見晴らし|向き|階|マンション|アパート|タワマン|構造|鉄骨|木造|基調|白|黒|おしゃれ|汚|古|ハウスメーカー|レオパレス|分譲|戸建|ゴミ|アメニティ|扉|ドア|広|狭|余裕|大きめ|帖|畳|インターネット|ネット|ガス/;

const KEEP_DOT_RE = /(バス|風呂|お風呂|浴室|トイレ)[・･](トイレ|バス|風呂|お風呂|浴室)|(洗面)[・･](脱衣)|(キッチン)[・･](ダイニング)|(TV)[・･](モニタ)/g;
const DOT = "\u0000";
function splitWantClauses(s: string): string[] {
  const kept = norm(s).replace(KEEP_DOT_RE, (m) => m.replace(/[・･]/, DOT));
  return kept.split(/[\n。、,，/／]|・|\s(?=[^\s]{2,})(?<=[^\s]{2,}\s)/)
    .map((x) => x.split(DOT).join("・").replace(/^\s*(?:[①-⑳]|[0-9]{1,2}[.)）、]|[-・*]+)\s*/, "").trim())
    .filter((x) => x.length >= 2 && x.length <= 80);
}

/** additional_conditions の記録（「[9/11 12:02|format] …」「## 読み取り結果」）から希望の部分だけ取る */
function additionalToText(s: string): string {
  const out: string[] = [];
  for (const seg of norm(s).split(/\s\/\s|\n/)) {
    const t = seg.replace(/【[^】]*】/g, "").replace(/\[(?!必須)[^\]]*\]/g, "").trim();
    if (!t || /^(?:#|-|\*)|読み取り|画面の種類|物件を検索して/.test(t)) continue;
    // 「希望: …」「こだわり: …」だけ（「エリア:」「間取り:」「家賃:」「徒歩:」「入居:」「その他:」は別の所・雑談）
    for (const m of t.matchAll(/(?:希望|こだわり)[:：]\s*([^/]+?)(?=\s(?:エリア|間取り|家賃|徒歩|入居|その他|通勤|築年)[:：]|$)/g)) out.push(m[1]);
  }
  return out.join("、");
}

function parseFloorWants(c: string, field: WantField): EquipmentWant[] {
  const base = { mode: "must" as const, strong: STRONG_RE.test(c), soft: SOFT_RE.test(c), text: c, field };
  const n = (x: string) => toNum(x);
  const ngField = field === "ng_points";
  let m: RegExpMatchArray | null;
  if ((m = c.match(/([0-9０-９]{1,2}|[一二三四五六七八九十]{1,2})階(?:か|or|・|〜|~|から)([0-9０-９]{1,2}|[一二三四五六七八九十]{1,2})階/))) {
    const a = n(m[1]), b = n(m[2]);
    if (a != null && b != null) return [{ key: "floor", ...base, minFloor: Math.min(a, b), maxFloor: Math.max(a, b) }];
  }
  if ((m = c.match(/(?:1|１|一)階(?:は|が)?(?:NG|ng|不可|以外|嫌|避け|×|なし)/)) || (ngField && /^(?:1|１|一)階$/.test(c.trim()))) {
    return [{ key: "floor2", ...base, minFloor: 2 }];
  }
  if ((m = c.match(/([0-9０-９]{1,2}|[一二三四五六七八九十]{1,2})階未満(?:は|が)?(?:NG|ng|不可|嫌|×)?/))) {
    const a = n(m[1]);
    if (a != null) return [{ key: a === 2 ? "floor2" : "floor", ...base, minFloor: a }];
  }
  if ((m = c.match(/([0-9０-９]{1,2}|[一二三四五六七八九十]{1,2})階以上/))) {
    const a = n(m[1]);
    if (a == null) return [];
    const isNg = ngField || AFTER_NG_RE.test(c.slice((m.index ?? 0) + m[0].length));
    if (isNg) return [{ key: "floor", ...base, maxFloor: a - 1 }];
    return [{ key: a === 2 ? "floor2" : "floor", ...base, minFloor: a }];
  }
  if ((m = c.match(/([0-9０-９]{1,2}|[一二三四五六七八九十]{1,2})階以下/))) {
    const a = n(m[1]);
    if (a == null) return [];
    // 「4階以下NG[必須]」「（ng_points の）4階以下」＝5階以上
    const isNg = ngField || AFTER_NG_RE.test(c.slice((m.index ?? 0) + m[0].length));
    if (isNg) return [{ key: a + 1 === 2 ? "floor2" : "floor", ...base, minFloor: a + 1 }];
    return [{ key: "floor", ...base, maxFloor: a }];
  }
  return [];
}

/**
 * お客様の条件欄（preferences・ng_points・other_requests・additional_conditions・pet）から設備の希望を取る（決定論）。
 * 「バス・トイレ別」は「・」で割らない。ng_points の節は「無いほうがよい」向き（ただし 1階・3点ユニット・木造 は反転して must）。
 * どのキーにも当たらない節は、別の所で見る条件（家賃・築年・駅…）なら handledElsewhere、部屋・建物の条件なら uncovered、それ以外は other。
 * 2026-09-24 全299人に当てて読んだ直し: 「ペットなし（対応可能）」「ペット飼育なし」は自分の話で希望にしない／NG欄の「独立洗面なし」は must／
 *   「4階以下NG」は 5階以上／「同棲相手も…」は二人入居にしない／「都市ガスorオール電化」は soft／「バストイレ同室」（NG欄）は バス・トイレ別 must
 */
export function parseEquipmentWants(customer: CustomerConditionsLike | null | undefined): EquipmentWants {
  const res: EquipmentWants = { wants: [], uncovered: [], handledElsewhere: [], other: [] };
  if (!customer) return res;
  const fields: Array<[WantField, string]> = [
    ["preferences", String(customer.preferences ?? "")],
    ["other_requests", String(customer.other_requests ?? "")],
    ["additional_conditions", additionalToText(String(customer.additional_conditions ?? ""))],
    ["ng_points", String(customer.ng_points ?? "")],
  ];
  const seen = new Set<string>();
  const push = (w: EquipmentWant) => {
    const id = `${w.key}|${w.mode}|${w.minFloor ?? ""}|${w.maxFloor ?? ""}`;
    if (seen.has(id)) {
      const prev = res.wants.find((x) => `${x.key}|${x.mode}|${x.minFloor ?? ""}|${x.maxFloor ?? ""}` === id);
      if (prev && w.strong) prev.strong = true;
      if (prev && !w.soft) prev.soft = false;
      return;
    }
    seen.add(id);
    res.wants.push(w);
  };
  for (const [field, raw] of fields) {
    for (const c of splitWantClauses(raw)) {
      if (/^(?:特になし|なし|無し|ー|-)$/.test(c)) continue;
      const strong = STRONG_RE.test(c), soft = SOFT_RE.test(c);
      let hit = false;
      // 階
      for (const w of parseFloorWants(c, field)) { push(w); hit = true; }
      // 反転の言い方（無いほうがよい物＝ある方を must）
      if (/(?:3|３|三)点(?:式)?ユニット|ユニットバス(?:は|が)?(?:NG|ng|不可|嫌|×|以外)|バス・?トイレ(?:一緒|同室)|トイレ同室/.test(c) && !ACCEPT_ONLY_RE.test(c)) {
        if (field === "ng_points" || /NG|ng|不可|嫌|×|以外|避け/.test(c)) { push({ key: "bath_toilet", mode: "must", strong, soft, text: c, field }); hit = true; }
      }
      if (/木造/.test(c) && (field === "ng_points" || /以外|NG|ng|不可|嫌|×|避け/.test(c))) { push({ key: "not_wood", mode: "must", strong, soft, text: c, field }); hit = true; }
      if (ACCEPT_ONLY_RE.test(c)) hit = true; // 「ユニットバス可」は受け入れの話（希望ではない）
      const petSelfNone = PET_SELF_NONE_RE.test(c);
      for (const { key, re } of WANT_RES) {
        if (key === "bath_toilet" && (ACCEPT_ONLY_RE.test(c) || /(?:バス|風呂|浴室)・?トイレ(?:一緒|同室)|トイレ同室/.test(c))) continue;
        if (key === "pet" && petSelfNone) continue; // 自分はペットを飼っていない（希望ではない）
        const m = c.match(re);
        if (!m) continue;
        // 「オール電化orガス」「IHコンロ(ガスもOK)」のような選択は両方 soft にはせずそのまま
        const after = c.slice((m.index ?? 0) + m[0].length);
        let mode: "must" | "ng" = "must";
        if (AFTER_NG_RE.test(after) || AFTER_NG_RE.test(after.replace(/^(?:可|OK|可能|相談可?)/, ""))) mode = "ng";
        else if (field === "ng_points" && NG_FIELD_NONE_RE.test(after)) mode = "must"; // NG欄の「独立洗面なし」＝無いのが NG
        else if (field === "ng_points" && !/あり|付き|付|可|希望|欲しい|ほしい|必須/.test(c)) mode = "ng";
        push({ key, mode, strong, soft: soft || /^(?:も|でも)(?:OK|可|大丈夫)/.test(after), text: c, field });
        hit = true;
      }
      if (hit) continue;
      if (petSelfNone) { res.other.push({ text: c, field }); continue; }
      (META_RE.test(c) ? res.other : ELSEWHERE_RE.test(c) ? res.handledElsewhere : ROOMISH_RE.test(c) ? res.uncovered : res.other).push({ text: c, field });
    }
  }
  // 条件欄の pet=true（フォームの「ペット」）
  if (customer.pet === true || customer.pet === "true") push({ key: "pet", mode: "must", strong: false, soft: false, text: "ペット（条件欄）", field: "pet" });
  return res;
}

// ───────────────────────── 照らす ─────────────────────────

export type EquipmentMatchRow = {
  want: EquipmentWant;
  label: string;
  result: "ok" | "ng" | "unlisted";
  /** 画面の印: ○ / × / － / ○〔建〕 / △（ペット相談） */
  mark: string;
  why: string;
  fromBuilding?: boolean;
};
export type EquipmentMatch = { rows: EquipmentMatchRow[]; ok: number; ng: number; unlisted: number; strongNg: boolean };

export function wantLabel(w: EquipmentWant): string {
  const base = w.key === "floor"
    ? (w.minFloor != null && w.maxFloor != null ? `${w.minFloor}〜${w.maxFloor}階` : w.minFloor != null ? `${w.minFloor}階以上` : `${w.maxFloor}階以下`)
    : w.key === "floor2" && w.minFloor && w.minFloor > 2 ? `${w.minFloor}階以上` : EQUIP_LABELS[w.key];
  return w.mode === "ng" ? `${base}NG` : base;
}

/** 希望と資料の事実を照らす（決定論）。unlisted は「書いていない」で、NG ではない */
export function matchEquipment(wants: EquipmentWants | EquipmentWant[], facts: ListingEquipment): EquipmentMatch {
  const list = Array.isArray(wants) ? wants : wants.wants;
  const rows: EquipmentMatchRow[] = [];
  for (const w of list) {
    const label = wantLabel(w);
    let result: EquipmentMatchRow["result"] = "unlisted", why = "資料に記載なし", fromBuilding = false;
    if (w.key === "floor" || (w.key === "floor2" && (w.minFloor ?? 2) !== 2)) {
      if (facts.basement) { result = "ng"; why = "地下"; }
      else if (facts.floor != null) {
        const f = facts.floor;
        const inRange = (w.minFloor == null || f >= w.minFloor) && (w.maxFloor == null || f <= w.maxFloor);
        result = inRange ? "ok" : "ng";
        why = facts.items.floor2.evidence ?? `${f}階`;
      }
    } else {
      const fact = facts.items[w.key as EquipKey];
      if (fact.status !== "unlisted") {
        const has = fact.status === "ok";
        result = w.mode === "must" ? (has ? "ok" : "ng") : (has ? "ng" : "ok");
        why = fact.evidence ?? "";
        fromBuilding = !!fact.fromBuilding;
      } else if (fact.hint) why = fact.hint;
    }
    const petAsk = w.key === "pet" && w.mode === "must" && result === "ok" && facts.items.pet.detail === "相談";
    const mark = result === "ok" ? (fromBuilding ? "○〔建〕" : petAsk ? "△" : "○") : result === "ng" ? "×" : "－";
    rows.push({ want: w, label, result, mark, why: petAsk ? `${why}（相談）` : why, ...(fromBuilding ? { fromBuilding } : {}) });
  }
  return {
    rows,
    ok: rows.filter((r) => r.result === "ok").length,
    ng: rows.filter((r) => r.result === "ng").length,
    unlisted: rows.filter((r) => r.result === "unlisted").length,
    strongNg: rows.some((r) => r.result === "ng" && r.want.strong),
  };
}

/** 画面・ログ用の1行（「2階以上○ エレベーター○〔建〕 独立洗面台－ …」） */
export function formatEquipmentMatch(m: EquipmentMatch): string {
  return m.rows.map((r) => `${r.label}${r.mark}`).join(" ");
}

// ───────────────────────── 文字で決まらない希望を聞く時の前置き（キャッシュ用） ─────────────────────────

/**
 * 固定の前置き（物件・お客様で変わらない指示だけ）。DeepSeek のプロンプトキャッシュは先頭から一致した部分に効くので、
 * ここに日時・物件名・お客様の言葉を入れない（テストで固定を見張る）。
 */
export const EQUIPMENT_ASK_SYSTEM = [
  "あなたは賃貸の物件資料の文字を読む係です。",
  "与えられる【資料の文字】だけを根拠に、【確かめる希望】の各項目がこの部屋に当てはまるかを答えます。",
  "決まり:",
  "1. 資料にその言葉がはっきり書いてある時だけ ok か ng にする。書いていない・読み取れない時は unknown。推測しない。",
  "2. ng は反対の事がはっきり書いてある時だけ（例: 「1階」「ペット不可」「3点ユニット」「洗濯機置場（屋外）」「駐車場 空きなし」）。",
  "3. 「風呂（ユニットバス）」は浴槽の型で、3点ユニット（トイレと同室）とは読まない。",
  "4. why には資料の文字をそのまま短く書く（20字まで）。unknown の時は空でよい。",
  "5. 【決まった事実】に書いてある項目は答え直さない（聞かれた項目だけ答える）。",
  "出力は JSON だけ: {\"answers\":[{\"id\":\"Q1\",\"result\":\"ok|ng|unknown\",\"why\":\"…\"}]}",
].join("\n");

/**
 * 文字で決まらない希望（uncovered）だけを聞く時のメッセージ。固定の前置き（system）を先頭に、物件ごとの文字（user）を後ろに置く。
 * 呼び出しはまだ無い（設備と階は parseListingEquipment の決定論で決め、費用 0）。
 */
export function buildEquipmentAskPrompt(input: { clauses: string[]; listingText: string; facts?: ListingEquipment | null; maxChars?: number }): { system: string; user: string } {
  const known = input.facts
    ? Object.fromEntries(EQUIP_KEYS.filter((k) => input.facts!.items[k].status !== "unlisted").map((k) => [EQUIP_LABELS[k], input.facts!.items[k].status]))
    : {};
  const floor = input.facts?.floor != null ? { 所在階: input.facts.floor } : {};
  const user = [
    `【決まった事実】${JSON.stringify({ ...floor, ...known })}`,
    `【資料の文字】\n${norm(input.listingText).slice(0, input.maxChars ?? 3000)}`,
    `【確かめる希望】\n${input.clauses.map((c, i) => `Q${i + 1}: ${c}`).join("\n")}`,
  ].join("\n\n");
  return { system: EQUIPMENT_ASK_SYSTEM, user };
}
