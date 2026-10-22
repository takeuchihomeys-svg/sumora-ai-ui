// app/lib/recommend-second-appeal.ts（純関数・DB/LLM なし。サーバーの判定で使う＝osaka-geo の表が大きいので画面から import しない）
// AIX【物件オススメ】の直後の2通目（✨ aix-template-generate）を竹内さんの2通目の形に寄せる（スイッチ RECOMMEND_SECOND_APPEAL）。
//
// 2026-10-23 試験（scripts/exam-aix-text.ts・竹内さんの送った文が正解）で物件オススメが一番弱い（5問中1問前後・約68点）。
//   中身を読むと、家賃管理費込の合計・帖数・内覧／申込の誘い・物件名は**材料（1通目の🌟カード）に有るのに落ちていた**:
//   ① 希望とのずれ（recommend-second-wish-gap）が、お客様の欄の古い希望（浪速区）だけで「最寄り駅西長堀駅となりますが…」を書かせていた。
//      お客様が直近で「堀江あたりも見たい」と言い、スタッフが「堀江周辺も含めて…ピックアップ」と送った束の中の1件＝ずれではない。
//      その時は「お送りさせて頂きましたお部屋の中でも」の形も禁じられ、家賃の金額も「足さない」になっていた。
//   ② 2通目の形の指示が「理由は1〜2つ」＝竹内さんの文（敷金礼金・築年・リビング8帖、洋室4帖の間取り・家賃管理費込123,000円）より薄い。
//   ③ 締めが「決められない→ご査収だけ」＝竹内さんの決定 b5043827（10/20）「内覧の訴求か申込の訴求を入れて動かす」・6bdfb441（新着なら申込で抑える）と逆。
//      竹内さんの形は「お気に召されましたら…ご案内させて頂きます！！⏎お手隙の際にご査収ください😌！！」（誘導＋ご査収）。
// 直し（材料は作らない・1通目と資料に有る事実だけ）:
//   ① 直近の会話（お客様の言葉・スタッフのピックアップの宣言）が物件の場所を含む時は、ずれと言わない（recentRequestCoversProperty）
//   ② 理由を2〜4つ・家賃は1通目に合計がある時だけ「家賃管理費込◯円」・帖数は字のまま（指示）
//   ③ 決められない時も誘導（空室→内覧／新着・退去予定・すぐ来られない→申込）＋ご査収の1行（指示＋出口 appendReceiptAfterCta）
//   ブレインが押さない（engagement_stance=wait）・お客様が懸念/条件変更/断り の時は今まで通り押さない（recommend-cta の HOLD_BACK）。
//   戻すのは RECOMMEND_SECOND_APPEAL=off
import { parseAreaWant, matchArea } from "./area-want";
import { stationPoint } from "./osaka-geo";
import { locationFromStations, stationsInFirstMessage, type StationRead } from "./recommend-second-wish-gap";

export function recommendSecondAppealOn(env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {})): boolean {
  return String(env.RECOMMEND_SECOND_APPEAL ?? "on").trim().toLowerCase() !== "off";
}

type Msg = { sender?: string | null; text?: string | null; createdAt?: string | null; rawCreatedAt?: string | null };

/** 直近の「どこを探すか」の言葉（お客様の発言と、スタッフのピックアップ・お探しの宣言）。画像・🌟カードは数えない */
export function recentAreaText(recent: ReadonlyArray<Msg> | null | undefined, nowMs: number = Date.now(), days = 21): string {
  const out: string[] = [];
  for (const m of recent ?? []) {
    const t = String(m.text ?? "").trim();
    if (!t || /^\[画像\]$/.test(t) || /^[🌟【]/.test(t)) continue;
    const at = Date.parse(String(m.rawCreatedAt ?? m.createdAt ?? ""));
    if (Number.isFinite(at) && nowMs - at > days * 86400_000) continue;
    if (m.sender === "customer") out.push(t);
    else if (/ピックアップ|お探し|周辺全域/.test(t)) out.push(t.split("\n").filter((l) => /ピックアップ|お探し|周辺|全域|エリア/.test(l)).join("\n"));
  }
  return out.filter(Boolean).join("\n");
}

const IN_RESULTS = new Set(["station", "ward", "line", "region", "anchor", "anchor_some", "anchor_taxi"]);
const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * 直近の会話が物件の場所を求めている（＝希望とのずれではない）か。
 *   物件の場所は1通目の交通（スタッフが確かめた駅）と売上サポの行の交通だけ。直近の言葉の駅・区・路線に合う／地名（堀江等）の範囲内なら true。
 *   読めない時は false（＝今まで通りの判定に任せる）。
 */
export function recentRequestCoversProperty(i: { recentText: string; firstMessage?: string | null; materialStations?: ReadonlyArray<StationRead> | null }): { covered: boolean; why: string } {
  const text = String(i.recentText ?? "").trim();
  if (!text) return { covered: false, why: "no_recent" };
  const want = parseAreaWant(text, null);
  if (!want.any) return { covered: false, why: "no_area_in_recent" };
  const reads = [...stationsInFirstMessage(i.firstMessage), ...(i.materialStations ?? [])];
  if (!reads.length) return { covered: false, why: "no_property_station" };
  const loc = locationFromStations(reads);
  const m = matchArea(want, loc);
  if (m && IN_RESULTS.has(m.result)) return { covered: true, why: `recent:${m.code}` };
  for (const p of want.places ?? []) {
    for (const s of loc.stations) {
      const sp = stationPoint(s.station);
      if (!sp || sp.approx) continue;
      if (km(sp, p.point) <= p.radiusKm + 0.3) return { covered: true, why: `recent_place:${p.name}~${s.station}` };
    }
  }
  return { covered: false, why: `recent_out:${m?.code ?? "-"}` };
}

/** 竹内さんの2通目の締めの2行目（誘導の次の行） */
export const SECOND_RECEIPT_LINE = "お手隙の際にご査収ください😌！！";
const RECEIPT_LINE_RE = /^お手隙の際に(?:ごゆっくり)?(?:ご査収|ご確認|ご検討)(?:ください|下さい)[^\n]{0,6}$/;
// 行の頭に一言（「こちらのお部屋は…ので、」）が付いた誘導も誘導の行と見る（行の終わりが誘導で終わる物だけ）
const CTA_LINE_RE = /お気に召(?:され|し)(?:まし)?たら?[^\n]{0,60}?(?:ご案内|ご内覧|申込|抑え|押さえ)[^\n]{0,30}$/;

/**
 * 出口: 誘導（内覧／申込）の締めの次の行に「お手隙の際にご査収ください😌！！」を置く（竹内さんの形）。
 *   最後の誘導の行の後に既にご査収の行があれば何もしない。ご査収の行が誘導の前にあれば誘導の後へ移す。
 *   誘導の行の絵文字（😊）はご査収の行に寄せて外す（竹内さんの文は誘導が「！！」・ご査収が😌）。本文の事実は触らない。
 */
export function appendReceiptAfterCta(text: string): { text: string; applied: string | null } {
  const src = String(text ?? "").replace(/\s+$/, "");
  if (!src.trim()) return { text, applied: null };
  const lines = src.split("\n");
  let ctaIdx = -1;
  for (let k = lines.length - 1; k >= 0; k--) { if (CTA_LINE_RE.test(lines[k].trim())) { ctaIdx = k; break; } }
  if (ctaIdx < 0) return { text, applied: null };
  const after = lines.slice(ctaIdx + 1).filter((l) => l.trim());
  if (after.some((l) => RECEIPT_LINE_RE.test(l.trim()))) return { text, applied: null };
  let moved = false;
  const kept = lines.filter((l, k) => {
    if (k < ctaIdx && RECEIPT_LINE_RE.test(l.trim())) { moved = true; return false; }
    return true;
  });
  let at = kept.length - 1;
  for (let k = kept.length - 1; k >= 0; k--) { if (CTA_LINE_RE.test(kept[k].trim())) { at = k; break; } }
  kept[at] = kept[at].replace(/[\p{Extended_Pictographic}\u{FE0F}]+(！！)\s*$/u, "$1");
  kept.splice(at + 1, 0, SECOND_RECEIPT_LINE);
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, applied: moved ? "moved" : "added" };
}

/**
 * 出口: 1通目に家賃管理費込の合計（「（合計123,000円）」）があり、2通目に家賃の事が1つも無い時、オススメの文（「〜さんにかなりオススメ出来る」）の手前に
 *   「家賃管理費込123,000円」を足す（竹内さんの実送信 10/22「…リビング8帖、洋室4帖の使いやすい間取りで家賃管理費込123,000円と…」）。
 *   数字は1通目の字のまま（作らない）。オススメの文が見つからない・家賃を既に書いている時は何もしない。「好条件」「相場」は足さない。
 */
export function ensureRentTotalInRecommend(text: string, rentTotal: number | null | undefined): { text: string; applied: boolean } {
  const src = String(text ?? "");
  if (!rentTotal || !src.trim()) return { text: src, applied: false };
  if (/家賃|管理費|共益費|[\d,]{5,}円/.test(src.normalize("NFKC"))) return { text: src, applied: false };
  const yen = `家賃管理費込${rentTotal.toLocaleString("ja-JP")}円`;
  // 「…で、YUMAさんにかなりオススメ出来る」「…しており、〇〇さんにかなりオススメ」「…角部屋、かなりオススメ」
  const m = src.match(/([^\n、。！!]{1,40}?)([、,])((?:[^\s、。！!\n]{1,12}さん)?に?かなりオススメ出来る)/);
  if (!m || m.index === undefined) return { text: src, applied: false };
  const head = m[1];
  let rebuilt: string;
  if (/で$/.test(head)) rebuilt = `${head.slice(0, -1)}・${yen}で${m[2]}${m[3]}`;
  else if (/(?:く|り|て|し)$/.test(head)) rebuilt = `${head}${m[2]}${yen}で${m[2]}${m[3]}`;
  else rebuilt = `${head}・${yen}で${m[2]}${m[3]}`;
  return { text: src.slice(0, m.index) + rebuilt + src.slice(m.index + m[0].length), applied: true };
}
