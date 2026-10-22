// app/lib/recommend-second-wish-gap.ts（純関数・DB/LLM なし。サーバーの判定で使う＝osaka-geo の表が大きいので画面から import しない）
// AIX【物件オススメ】の直後の2通目（✨ aix-template-generate）に、竹内さんの2通目の型の材料を渡す:
//   ①希望と違う条件を正直に先に ②良い条件を具体的に ③なぜ良いか（相場は根拠がある時だけ）④内覧誘導 ⑤締め
//
// 2026-10-15 竹内悠馬（KAORI さん・ギガ賃貸の実送信 10/12 21:01）:
//   「最寄り駅瓢箪山駅となりますがこちらのお部屋如何でしょうか！！
//    家賃管理費込75,700円、2019年9月築で築年数浅く、ペット共生マンションでペット飼育可能・インターネット無料の2LDKと好条件で
//    〇〇さんにかなりオススメ出来るお部屋となります😊！！ …」
//   お客様の希望は 布施〜八戸の里。物件は外れる → 外れる事を先に正直に書いて勧める。
// ■ 実送信（120日・2通目 412通）: 「〜となりますがこちらのお部屋如何でしょうか」型 13通（「最寄り江坂駅となりますが、こちらのお部屋如何でしょうか😊！！」
//   「地域花園町と少し外れますがこちらのお部屋如何でしょうか😌！！」）・家賃管理費込 111通・相場/好条件 15通。
// ■ 決め（9eb6aa9c: 規則は候補の網と安全の線だけ。何を書くかは文を書く側）
//   - ずれは「お客様の希望のエリア（property_customers）と物件の駅」の比べ（area-want.matchArea）だけで決める。推測で書かない。
//   - 駅の名前を書いてよいのは、スタッフが送った1通目の本文か売上サポの行（資料の交通）に駅がある時だけ。
//     送った資料の画像の読み（sent_image_properties）だけの駅は名前を書かない（KAORI さんの回: 読みは四条畷・AIX の下書きは河内山本・実際は瓢箪山）。
//     その時は「（希望のエリア）から少し外れますが」の形にする。
//   - どれか1つの出どころでも希望の中なら、ずれとは言わない（外れると言い切らない側）。
//   - 相場は、希望のエリアの同じ間取りの家賃（rent_observations・10件以上）の下から25%以下の時だけ「好条件」と言ってよい（数字の相場は書かない）。
//   - 戻すのは RECOMMEND_SECOND_WISH_GAP=off
import { parseAreaWant, matchArea, fixStationName, type PropertyLocation, type AreaMatch } from "./area-want";
import { stationPoint, wardOfStation, isKnownStation, wardPoint } from "./osaka-geo";
import { planGroupOf, type RentBand } from "./area-rent-explain";

export function secondWishGapEnabled(env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {})): boolean {
  return String(env.RECOMMEND_SECOND_WISH_GAP ?? "on").trim().toLowerCase() !== "off";
}

export type StationRead = { station: string; walk: number | null; line?: string | null };
export type WishGap = { kind: "station"; station: string; area: string } | { kind: "area"; area: string };

// 希望そのもの（希望の駅・区・路線・範囲・「A に出やすい」）だけを希望の中とみる。
//   隣の駅（station_wide）・2km 内（near）・難波の3区（ward_wide）は竹内さんは「外れる」と書く:
//   HONOKA さん（希望 新大阪・東三国）の江坂（東三国の隣）→「最寄り江坂駅となりますが、こちらのお部屋如何でしょうか😊！！」（10/05）
//   あやさん（希望 動物園前・天王寺…）の花園町 →「地域花園町と少し外れますがこちらのお部屋如何でしょうか😌！！」（9/16）
const IN_AREA = new Set(["station", "ward", "line", "region", "anchor", "anchor_some", "anchor_taxi"]);
const OUT_AREA = new Set(["station_wide", "ward_wide", "near", "far", "close", "excluded"]);

/** 駅の一覧 → 照らす形（area-want.buildPropertyLocation と同じ組み立て・資料の文が無い時用） */
export function locationFromStations(reads: ReadonlyArray<StationRead>): PropertyLocation {
  const stations: PropertyLocation["stations"] = [];
  for (const r of reads) {
    const s = fixStationName(String(r.station ?? "").replace(/駅$/, ""));
    if (!s || stations.some((x) => x.station === s)) continue;
    stations.push({ station: s, walk: typeof r.walk === "number" ? r.walk : null, line: r.line ?? null, known: isKnownStation(s) });
  }
  stations.sort((x, y) => (x.walk ?? 99) - (y.walk ?? 99));
  let ward: string | null = null;
  for (const s of stations) { const w = wardOfStation(s.station); if (w) { ward = w; break; } }
  const knownSt = stations.find((s) => s.known && stationPoint(s.station) && !stationPoint(s.station)?.approx);
  let point: PropertyLocation["point"] = null, pointSource: PropertyLocation["pointSource"] = null;
  if (knownSt) { const p = stationPoint(knownSt.station)!; point = { lat: p.lat, lon: p.lon }; pointSource = "station"; }
  else if (ward) { const p = wardPoint(ward); if (p) { point = p; pointSource = "ward"; } }
  return { stations, ward, wardSource: ward ? "station" : null, point, pointSource };
}

/** 1通目の本文の交通（「近鉄大阪線「河内山本」駅徒歩15分」「江坂駅徒歩5分」）。🌟カードの行だけ読む */
export function stationsInFirstMessage(text: string | null | undefined): StationRead[] {
  const out: StationRead[] = [];
  for (const raw of String(text ?? "").normalize("NFKC").split("\n")) {
    const l = raw.replace(/^[・\s]+/, "");
    for (const m of l.matchAll(/(?:「([^」]{1,12})」|([^\s「」・、,（）()]{1,12}?))\s*駅?\s*(?:から)?\s*徒歩\s*(\d{1,2})\s*分/g)) {
      const st = (m[1] ?? m[2] ?? "").replace(/駅$/, "").replace(/^.*(?:線|ライン)/, "");
      if (st && !/^(最寄り?|駅)$/.test(st)) out.push({ station: st, walk: Number(m[3]) });
    }
  }
  return out;
}

/** 希望のエリアの言い方（お客様の欄の字のまま・長すぎる時は駅名だけ） */
function areaLabelOf(desiredArea: string, stationsWanted: string[]): string | null {
  const raw = desiredArea.normalize("NFKC").replace(/\s+/g, "").replace(/(?:あたり|辺り|周辺|付近|エリア|方面)$/, "");
  if (raw && raw.length <= 14 && !/[、,。]/.test(raw)) return raw;
  return stationsWanted.length ? stationsWanted.slice(0, 2).join("・") : null;
}

export type WishGapInput = {
  /** property_customers.desired_area（無ければ条件の文） */
  desiredArea: string | null | undefined;
  freeText?: string | null;
  /** スタッフが送った1通目（駅を書いていればスタッフが確かめた駅） */
  firstMessage?: string | null;
  /** 売上サポの行の交通（資料の交通） */
  materialStations?: ReadonlyArray<StationRead> | null;
  /** 売上サポの行の照らし（property_pickups.location.area の code） */
  materialAreaCode?: string | null;
  /** 送った資料の画像の読み（名前は書かない出どころ） */
  savedReadStations?: ReadonlyArray<StationRead> | null;
};

/** 希望のエリアとのずれ（無い・決められない時は gap=null と理由） */
export function resolveWishAreaGap(i: WishGapInput): { gap: WishGap | null; reason: string } {
  const desired = String(i.desiredArea ?? "").trim();
  if (!desired) return { gap: null, reason: "no_desired_area" };
  const want = parseAreaWant(desired, i.freeText ?? null);
  if (!want.any || !(want.stations.length || want.wards.length || want.lines.length || want.places.length || want.regions.length)) return { gap: null, reason: "area_not_concrete" };
  const area = areaLabelOf(desired, want.stations.map((s) => s.word || s.station));
  if (!area) return { gap: null, reason: "no_area_label" };
  type Src = { verified: boolean; reads: StationRead[] };
  const srcs: Src[] = [
    { verified: true, reads: stationsInFirstMessage(i.firstMessage) },
    { verified: true, reads: [...(i.materialStations ?? [])] },
    { verified: false, reads: [...(i.savedReadStations ?? [])] },
  ].filter((s) => s.reads.length);
  let anyOut = false, anyIn = false;
  if (i.materialAreaCode) {
    // レビュー 10/16: 近い・遠い（NEAR/CLOSE/FAR）は希望の市区の真ん中からの距離のことがある（駅の市区が表に無い時・東大阪市×瓢箪山）→ 行の駅の比べ（下）に任せる
    if (/EXCLUDED|WIDE|2STOPS/.test(i.materialAreaCode)) anyOut = true;
    else if (/MATCH|REGION|ANCHOR/.test(i.materialAreaCode)) anyIn = true;
  }
  let verifiedStation: string | null = null;
  for (const s of srcs) {
    const loc = locationFromStations(s.reads);
    const m: AreaMatch | null = matchArea(want, loc);
    if (!m) continue;
    if (IN_AREA.has(m.result)) anyIn = true;
    // レビュー 10/16: 希望が市区（東大阪市・堺市・豊中市）で駅の市区が表に無い時の near/close/far は、市区の真ん中からの距離だけ＝市の中の駅でも「外れ」と出る
    //   （東大阪市×瓢箪山 3.4km・堺市×中百舌鳥・豊中市×服部天神）→ 外れとは言わない側（決めない）
    else if (OUT_AREA.has(m.result) && !(/^(?:near|close|far)$/.test(m.result) && /[市区]$/.test(m.anchor ?? "") && !loc.ward)) {
      anyOut = true;
      if (s.verified && !verifiedStation && loc.stations[0]) verifiedStation = loc.stations[0].station;
    }
  }
  if (anyIn) return { gap: null, reason: "in_area" };
  if (!anyOut) return { gap: null, reason: "no_location" };
  return verifiedStation
    ? { gap: { kind: "station", station: verifiedStation, area }, reason: "out_verified_station" }
    : { gap: { kind: "area", area }, reason: "out_area" };
}

/** 1通目の家賃管理費込の合計（「（合計75,700円）」「家賃管理費込75,700円」「家賃68,000円・管理費7,700円」） */
export function rentTotalOfFirst(text: string | null | undefined): number | null {
  const t = String(text ?? "").normalize("NFKC").replace(/,/g, "");
  const total = t.match(/合計\s*(\d{4,7})\s*円/) ?? t.match(/家賃管理費込み?\s*(\d{4,7})\s*円/);
  if (total) return Number(total[1]);
  const rent = t.match(/家賃\s*(\d{4,7})\s*円/);
  if (!rent) return null;
  const admin = t.match(/(?:管理費|共益費)\s*(\d{3,6})\s*円/);
  if (admin) return Number(rent[1]) + Number(admin[1]);
  if (/管理費(?:なし|無し|0円)/.test(t)) return Number(rent[1]);
  return null;
}

/** 1通目の間取り（「間取り：2LDK」「2LDK」） */
export function planOfFirst(text: string | null | undefined): string | null {
  const m = String(text ?? "").normalize("NFKC").match(/([1-9]S?(?:LDK|DK|K|R))/i);
  return m ? m[1].toUpperCase() : null;
}

/** 相場より安いと言ってよいか（希望のエリアの同じ間取りの材料が10件以上・下から25%以下） */
export function cheapVsMarket(rentTotal: number | null, band: RentBand | null): boolean {
  if (!rentTotal || !band || !band.sayable) return false;
  return rentTotal <= band.p25;
}

/** 間取りの比べの区分（相場を読む側が使う） */
export { planGroupOf };

export type WishGapNoteInput = {
  gap: WishGap | null;
  rentTotal: number | null;
  cheap: boolean;
  /** 相場の比べ（ブレイン向けの根拠。お客様の文には数字を書かない） */
  marketBasis?: string | null;
  name?: string | null;
  /** 2026-10-23（recommend-second-appeal・RECOMMEND_SECOND_APPEAL）: 相場で安いと言えない時も、1通目の合計を「家賃管理費込◯円」の事実として書いてよい（好条件とは言わない） */
  rentTotalAsFact?: boolean;
};

/** ずれの1行（竹内さんの実送信の形） */
export function wishGapLine(gap: WishGap): string {
  return gap.kind === "station" ? `最寄り駅${gap.station}駅となりますがこちらのお部屋如何でしょうか！！` : `${gap.area}から少し外れますがこちらのお部屋如何でしょうか！！`;
}

/**
 * 出口: ずれの1行を書き出しに置く（作り直しはしない・決定論）。
 *   2026-10-15 YUMA・DeepSeek: 指示だけだと「こちらのお部屋如何でしょうか😊！！⏎最寄り駅江坂駅となりますが、…」と2行目の途中に入れたり（2/4）、書かなかったり（1/4）した。
 *   - 1行目（挨拶の行の次）にずれの言い方があればそのまま
 *   - 本文の途中のずれの言い方（「〜となりますが、」「〜から少し外れますが、」）は外し、書き出しの「（名前さん）こちらのお部屋如何でしょうか」の行をずれの1行に替える（絵文字はそのまま）
 *   - 書き出しにその行が無ければ、ずれの1行を先頭（挨拶の行の次）に足す
 */
export function ensureWishGapOpening(text: string, gap: WishGap | null): { text: string; applied: string | null } {
  if (!gap || !text.trim()) return { text, applied: null };
  const lines = text.split("\n");
  // 挨拶の行（「KAORIさん お世話になっております！！」と名前がつながった形も）の次が書き出し
  const greetIdx = /^(?:[^\s、。！!]{1,15}さん[ \t　]*)?お世話になっております/.test(lines[0]?.trim() ?? "") ? 1 : 0;
  let first = greetIdx;
  while (first < lines.length && !lines[first].trim()) first++;
  const GAP_IN = /(?:最寄り駅?[^\s、。！!]{1,12}?駅となりますが|[^\s、。！!]{1,16}?から少し外れますが)[、,]?/;
  const prefix = gap.kind === "station" ? `最寄り駅${gap.station}駅となりますが` : `${gap.area}から少し外れますが`;
  const firstHit = (lines[first] ?? "").match(GAP_IN);
  if (firstHit) {
    if (lines[first].includes(prefix)) return { text, applied: null };
    // レビュー 10/16: 書き出しのずれの言い方が決めた物と違う（資料の読みの駅「四条畷」・エリアの形なのに駅の名前）→ 決めた言い方に替える
    //   名前の頭（「YUMAさん」）は外してから替える（名前の途中から当たって「YUMA布施…」と壊さない・ずれの1行は名前なしの形）
    lines[first] = lines[first].replace(/^[^\s、。！!]{1,12}?さん[ \t　]*/, "").replace(GAP_IN, prefix);
    return { text: lines.join("\n"), applied: "corrected" };
  }
  let removed = false;
  for (let k = 0; k < lines.length; k++) {
    if (k === first) continue;
    if (GAP_IN.test(lines[k])) { lines[k] = lines[k].replace(GAP_IN, ""); removed = true; }
  }
  const line = wishGapLine(gap);
  const ASK = /^(?:[^\s、。！!]{1,12}さん)?こちらのお部屋如何でしょうか([\p{Extended_Pictographic}\u{FE0F}]*)！+/u;
  const m = (lines[first] ?? "").match(ASK);
  if (m) {
    // 同じ行に続きがあれば残す（「こちらのお部屋如何でしょうか😊！！ 家賃管理費込…」）
    lines[first] = line.replace(/！！$/, `${m[1] ?? ""}！！`) + lines[first].slice(m[0].length);
    // 途中のずれを外した後に「こちらのお部屋如何でしょうか」だけが残った行は重ねない
    const out = lines.filter((l, k) => k === first || !(removed && ASK.test(l.trim()) && !l.trim().replace(ASK, "").trim()));
    return { text: out.join("\n"), applied: removed ? "moved" : "replaced" };
  }
  lines.splice(greetIdx, 0, line);
  return { text: lines.join("\n"), applied: removed ? "moved_insert" : "inserted" };
}

/** 2通目の型の注記（プロンプトの最後のほう・場面の形の後に置く）。渡す物が無ければ "" */
export function buildSecondWishGapNote(i: WishGapNoteInput): string {
  if (!i.gap && !i.cheap) return "";
  const san = i.name?.trim() ? `${i.name.trim()}さん` : "";
  const yen = i.rentTotal ? `${i.rentTotal.toLocaleString("ja-JP")}円` : null;
  const L: string[] = ["【竹内さんの2通目の型（希望とのずれ・好条件。上の形と食い違う所はこちらが正）】"];
  if (i.gap) {
    L.push(i.gap.kind === "station"
      ? `・1行目は、お客様のご希望（${i.gap.area}）と違う所を先に正直に書いて勧める: 「${wishGapLine(i.gap)}」（竹内さんの実送信の形のまま）`
      : `・1行目は、お客様のご希望（${i.gap.area}）から外れる事を先に正直に書いて勧める: 「${wishGapLine(i.gap)}」（最寄り駅の名前は資料の読みが確かでないので書かない）`);
    L.push("　この1行を書く時は「1件新着で…募集に出ました」「お送りさせて頂きましたお部屋の中でも」の一文は書かない（1通目で伝えてある）。外れる事を謝りすぎない・言い訳を足さない。");
  }
  // 家賃管理費込で言うのは相場より安い時（竹内さんの決定 d94a966c「お得さが分かるように」）。それ以外は家賃を足さない（HONOKA さんの実送信は家賃なし）
  if (i.cheap) {
    L.push(`・次の行は良い条件を具体的に: ${yen ? `家賃は家賃管理費込の合計額「家賃管理費込${yen}」で先に書き、` : ""}1通目と【資料の事実】にある事実（築年・設備・間取り）を「、」でつなぎ、「〜と好条件で${san ? `${san}に` : ""}かなりオススメ出来るお部屋となります😊！！」で結ぶ。`);
    L.push(`・この家賃はご希望のエリアの同じ間取りの相場より安い（${i.marketBasis ?? "相場の材料で確かめた"}）→「好条件」（竹内さん 10/16「相場的にも好条件」の言い方も可）と書いてよい。相場の数字・「相場より」の言葉は書かない。`);
  } else {
    L.push(i.rentTotalAsFact && yen
      ? `・次の行は良い条件を具体的に: 1通目と【資料の事実】にある事実（築年・設備・間取りの帖数）と「家賃管理費込${yen}」を「、」でつなぎ、「〜${san ? `${san}に` : ""}かなりオススメ出来るお部屋となります！！」で結ぶ。`
      : `・次の行は良い条件を具体的に: 1通目と【資料の事実】にある事実（築年・設備・間取り）を「、」でつなぎ、「〜${san ? `${san}に` : ""}かなりオススメ出来るお部屋となります！！」で結ぶ。家賃の金額は足さない。`);
    L.push("・相場の事（「相場より安い」「好条件」）は書かない（相場の材料で確かめられていない）。");
  }
  L.push("・事実は1通目と【資料の事実】の字のまま。書いていない設備・数字を作らない。");
  return L.join("\n");
}
