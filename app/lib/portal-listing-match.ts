// app/lib/portal-listing-match.ts（純関数・DB 依存なし・サーバー専用＝osaka-geo の駅名をそろえるため）
// お客様が送ってきたポータル（SUUMO・ニフティ・HOME'S・athome）の共有文・スクショの書き起こしから、物件の手がかり（駅・徒歩・家賃・間取り・広さ）を読み、
// 売上サポの行・送った画像の読み取り（どちらも物件名つき）と照らして、物件が1つに決まる時だけその物件として返す。
//
// 2026-10-14 竹内さん「お客様が SUUMO 等のポータルの URL・スクショを送ってきた時に、中身を読む仕組みが既にあるか確かめ、どこまで読めているかを数え、
//   読めていない所をつなぐ。物件名が無い時は駅・家賃・間取り・広さで売上サポ・帳簿の物件に当て、1つに決まる時だけその物件として扱う」
//   既にある物: 共有文の物件名（customer-property-names・SUUMO の「プルス新北野 3階」・athome の「物件名：」）／
//     スクショの書き起こし（line-webhook の Vision → messages.text「[画像] 【見出し】…」・own-property-match がこちらの送った物件か照らす）。
//   無い物: ページの中身は取りに行っていない（SUUMO の URL を開かない）／物件名の無い共有文（ニフティ「恵美須町 徒歩5分 1R 5.2万円」）は物件に結ばない。
//   → ここは物件名の無い共有文・スクショを、駅＋徒歩＋家賃＋間取り（＋広さ）で結ぶ。どれか1つでも違えば別の物件。
//     家賃は SUUMO が 0.1万円で丸めるので ±500円まで・広さは ±0.3㎡。手がかりが3つ（駅・家賃・間取り）未満なら結ばない。
// 戻す: PORTAL_LISTING_MATCH=off
import { normStation } from "./osaka-geo";

export function portalListingMatchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PORTAL_LISTING_MATCH ?? "").trim().toLowerCase() !== "off";
}

export type ListingClues = { station: string | null; walk: number | null; rentYen: number | null; madori: string | null; areaSqm: number | null };
export type PortalForm = "suumo_named" | "athome_named" | "no_name_share" | "screenshot" | "url_only" | "none";

const URL_RE = /https?:\/\/[^\s）)」』]+/g;
const PORTAL_HOST_RE = /suumo\.jp|homes\.co\.jp|chintai\.net|athome\.co\.jp|lifull\.com|nifty\.com|myhome\.nifty|door\.ac|apamanshop\.com|canary-app|eheya\.net|minimini\.jp|smocca\.jp|able\.co\.jp/i;

/** 物件の手がかりを読む（共有文・スクショの書き起こし） */
export function readListingClues(text: string | null | undefined): ListingClues {
  const t = String(text ?? "").normalize("NFKC").replace(URL_RE, " ");
  const out: ListingClues = { station: null, walk: null, rentYen: null, madori: null, areaSqm: null };
  // 駅＋徒歩（「恵美須町 徒歩5分」「「鴫野」徒歩10分」「天満駅 歩6分」）
  const sw = t.match(/[「『]?([一-龯ぁ-んァ-ヶー々ヶ]{1,12}?)[」』]?\s*駅?\s*(?:から)?\s*(?:徒歩|歩)\s*(\d{1,2})\s*分/);
  if (sw) { out.station = normStation(sw[1].replace(/^(?:線|本線)/, "")); out.walk = Number(sw[2]); }
  // 家賃（「5.2万円」「52,000円」。管理費・共益費・敷金・礼金の金額は取らない）
  const rm = t.match(/(?<![敷礼管共益費金]\s*[:：]?\s*)(?:賃料|家賃)?\s*(\d{1,3}(?:\.\d{1,2})?)\s*万円/);
  if (rm) out.rentYen = Math.round(Number(rm[1]) * 10000);
  else { const ry = t.match(/(?:賃料|家賃)\s*[:：]?\s*(\d{2,3},\d{3})\s*円/); if (ry) out.rentYen = Number(ry[1].replace(/,/g, "")); }
  const md = t.match(/(?<![A-Za-z0-9])([1-5])\s*(SLDK|LDK|SDK|DK|K|R)(?![A-Za-z])/i) ?? t.match(/(ワンルーム)/);
  if (md) out.madori = md[1] === "ワンルーム" ? "1R" : `${md[1]}${md[2].toUpperCase()}`;
  const ar = t.match(/(\d{1,3}(?:\.\d{1,2})?)\s*(?:㎡|m2|m²|平米)/);
  if (ar) out.areaSqm = Number(ar[1]);
  return out;
}

/** お客様の発言の形（数える・入口の判断用） */
export function portalFormOf(text: string | null | undefined, sharedNames: number): PortalForm {
  const t = String(text ?? "");
  if (/^\s*\[画像\]/.test(t)) return /SUUMO|suumo|LIFULL|HOME'?S|アットホーム|at\s*home|物件詳細|お気に入り|最近見た物件|ニフティ/i.test(t) ? "screenshot" : "none";
  const urls = [...t.matchAll(URL_RE)].map((m) => m[0]);
  if (!urls.some((u) => PORTAL_HOST_RE.test(u))) return "none";
  if (sharedNames > 0) return /物件名\s*[:：]/.test(t) ? "athome_named" : "suumo_named";
  const c = readListingClues(t);
  return c.station || c.rentYen ? "no_name_share" : "url_only";
}

export type ListingCandidate = { name: string; room?: string | null; station: string | null; walk: number | null; rentYen: number | null; madori: string | null; areaSqm: number | null; source: string };

/** 売上サポの説明文（「93,000円 9,000円\n1LDK 42.11㎡\n今里筋線「鴫野」徒歩10分」）から手がかり */
export function cluesFromPickupSummary(summary: string | null | undefined): Omit<ListingCandidate, "name" | "source"> {
  const t = String(summary ?? "").normalize("NFKC");
  const rent = t.match(/(\d{1,3}(?:,\d{3})+)\s*円/);
  const c = readListingClues(t);
  return { station: c.station, walk: c.walk, rentYen: rent ? Number(rent[1].replace(/,/g, "")) : c.rentYen, madori: c.madori, areaSqm: c.areaSqm };
}

/**
 * 手がかりで物件を1つに決める。駅・家賃・間取りの3つが要る（無ければ null）。候補の値が無い項目は比べない（違うとは言わない）が、
 * 駅・家賃・間取りは候補にも値がある物だけを候補にする。同じ物件名の候補は1つに数える（同じ建物の別の部屋は号室が違えば別）。
 */
export function matchListing(clues: ListingClues, cands: ReadonlyArray<ListingCandidate>, env: Record<string, string | undefined> = process.env): { match: ListingCandidate | null; hits: number } {
  if (!portalListingMatchEnabled(env)) return { match: null, hits: 0 };
  if (!clues.station || clues.rentYen == null || !clues.madori) return { match: null, hits: 0 };
  const hits = cands.filter((c) => {
    if (!c.station || c.rentYen == null || !c.madori) return false;
    if (normStation(c.station) !== clues.station) return false;
    if (Math.abs(c.rentYen - clues.rentYen!) > 500) return false;
    if (c.madori !== clues.madori) return false;
    if (clues.walk != null && c.walk != null && clues.walk !== c.walk) return false;
    if (clues.areaSqm != null && c.areaSqm != null && Math.abs(clues.areaSqm - c.areaSqm) > 0.3) return false;
    return true;
  });
  const keys = new Set(hits.map((h) => `${h.name.normalize("NFKC").replace(/\s/g, "")}|${h.room ?? ""}`));
  return { match: keys.size === 1 ? hits[0] : null, hits: keys.size };
}
