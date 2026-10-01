// 2026-10-01 竹内（YUMA に届いた AIX【待ち合わせ場所】「住所: 大阪府大阪市北区天満3丁目」を見て）:
//   「3丁目だけでおわる住所気をつける。ちゃんと番地と最後までいれる。たとえば3丁目のあとに続く1-27のように番地もいれる。
//    実際のLINEにはいれているし、もし記載ない場合はスタッフが確認する形とする」
//
// 待ち合わせは「現地エントランス」。番地が無いとお客様が建物にたどり着けない。
// - 原因: ITANDI の資料（property_pickups 2670）の所在地がそもそも「⼤阪府⼤阪市北区天満３丁⽬」で番地なし。
//   読み取りは資料どおりで、番地の無い住所を止める関所が無かった。資料の所在地が丁目で終わるのは約1%（itandi 8/536・realpro 15/1839）
// - 実送信（365日・YUMA 除く・「住所:」を含むスタッフの送信 112通）は全部番地あり → 番地なしを止めても実送信の誤止めは0（scripts/audit-meeting-address.ts）
//
// この1ファイルが「番地があるか」の唯一の物差し。画面（作成・送信）と aix/action の meeting_place が同じ関数で見る。
// 推測で番地を作らない。補うのは同じ会話・同じ物件の資料の文字（字のまま）だけ。

/** 番地が無い時に画面・サーバーで出す文（スタッフが資料で確かめて入れる） */
export const MEETING_ADDRESS_NO_BANCHI_MESSAGE = "番地が入っていません。資料で確かめて入れてください";

const DASH = "\\-‐‑‒–—―−ー－ｰ";

/** PDF から取った字の「部首の字」（⼤ ⽬ ⻄ 等・U+2F00–2FDF / U+2E80–2EFF）だけ普通の漢字へ。他の字は変えない */
export function normalizeRadicals(s: string): string {
  return s.replace(/[⺀-⻿⼀-⿟]/g, (ch) => ch.normalize("NFKC"));
}

/** 見分け用の正規化（全角数字・記号を半角へ。送る文字には使わない） */
function forCheck(raw: string): string {
  let s = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  s = s.replace(/^住所[:：]?\s*/, "");
  // 郵便番号（〒541-0052）は番地ではない
  s = s.replace(/〒?\s*\d{3}\s*[-‐−－]\s*\d{4}/g, " ");
  // 部屋番号・階は番地ではない（「107号室」「1F」「3階」）
  s = s.replace(/\d+\s*号室/g, " ").replace(/\d+\s*(?:階|[FＦ](?![A-Za-z]))/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * 住所に番地（数字）まで入っているか。
 * 番地あり: 「3丁目1-27」「3-1-27」「1丁目27番」「27番地」「1番27号」「2丁439」「4 丁目 193」「上町A-2」「野々井121」
 * 番地なし: 「天満3丁目」「◯◯町」「区まで」「建物名だけ」「2丁目(住居表示未定)」
 */
export function hasBanchi(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = forCheck(raw);
  if (!s) return false;
  // 数字-数字（1-27・3-1-27・A-2・7-(1)・１−３２）
  if (new RegExp(`[0-9A-Za-z]\\s*[${DASH}]\\s*\\(?[0-9]`).test(s)) return true;
  // 丁目（丁）のすぐ後に数字（3丁目1-27・3丁目 25・4 丁目 193・２丁439・1丁目 -34）
  if (new RegExp(`丁目?\\s*[${DASH}]?\\s*[0-9]`).test(s)) return true;
  // ◯番・◯番地（27番地・4番3・十番）
  if (/[0-9一二三四五六七八九十]+\s*番/.test(s)) return true;
  // ◯号（号室は除いた後）
  if (/[0-9]+\s*号/.test(s)) return true;
  // 丁目の無い地域の地番（野々井121・桑原町284）: 丁の字が無く、末尾が数字
  if (!/丁/.test(s) && /[^0-9\s]\s*[0-9]+\s*$/.test(s)) return true;
  return false;
}

/**
 * 待ち合わせ場所の住所の関所。空（住所なしで送る）は今の動きのまま通す（null）。
 * 入っているのに番地が無い時だけ理由を返す。
 */
export function meetingAddressProblem(address: string | null | undefined): string | null {
  const a = (address ?? "").trim();
  if (!a) return null;
  return hasBanchi(a) ? null : MEETING_ADDRESS_NO_BANCHI_MESSAGE;
}

/** 本文から「住所: …」の行を取り出す（無ければ ""） */
export function addressLineInText(text: string | null | undefined): string {
  const m = (text ?? "").match(/住所[:：]\s*([^\n]*)/);
  return m ? m[1].trim() : "";
}

/** 送る本文の関所（画面の送信・予約送信で見る）。住所の行が無ければ通す */
export function meetingTextAddressProblem(text: string | null | undefined): string | null {
  return meetingAddressProblem(addressLineInText(text));
}

const ADDRESS_LIKE = /(都|道|府|県|市|区|郡|町|村)/;

/**
 * 物件資料の文字（property_pickups.pdf_text）から所在地を取り出す。
 * 「所在地 大阪府…」の同じ行、同じ行が空なら次の行（リアプロの資料は次の行に書かれる事がある）。
 * 字のまま（部首の字だけ直し、PDF の抜き出しで入る空白は詰める）。
 */
export function materialAddressFromPdfText(pdfText: string | null | undefined): string {
  if (!pdfText) return "";
  const lines = pdfText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/所在地[\s:：]*(.*)$/);
    if (!m) continue;
    let v = m[1].trim();
    if (!v) {
      for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
        if (lines[j].trim()) { v = lines[j].trim(); break; }
      }
    }
    v = normalizeRadicals(v).replace(/\s+/g, "");
    if (v && ADDRESS_LIKE.test(v)) return v;
  }
  return "";
}

/** 住所を比べる鍵（全角半角・空白・郵便番号・都道府県をそろえる） */
function compareKey(s: string): string {
  return normalizeRadicals(s).normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/〒?\d{3}-?\d{4}/, "")
    .replace(/^.{2,3}?(都|道|府|県)/, "")
    .replace(/丁$/, "丁目");
}

/** 物件名の比べ方（空白・号室を外す） */
function nameKey(s: string): string {
  return normalizeRadicals(s ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/[0-9]+号室?$/, "");
}

/** その物件の行か（読み取った物件名に、行の物件名が含まれる・または逆） */
export function pickupMatchesName(pickupName: string | null | undefined, meetingName: string | null | undefined): boolean {
  const a = nameKey(pickupName ?? "");
  const b = nameKey(meetingName ?? "");
  if (a.length < 2 || b.length < 2) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * 読み取った住所に番地が無い時、同じ物件の資料の所在地で補う（資料の字のまま）。
 * - 読み取った住所が既に番地まである時は触らない（null）
 * - 候補は番地ありのものだけ。読み取った住所（丁目まで）と頭がそろう物だけ（別の町の住所で上書きしない）
 * - 番地の違う候補が2つ以上ある時は決めない（null・スタッフが確かめる）
 */
export function supplementMeetingAddress(ocrAddress: string | null | undefined, materialAddresses: string[]): string | null {
  const ocr = (ocrAddress ?? "").trim();
  if (ocr && hasBanchi(ocr)) return null;
  const ocrKey = ocr ? compareKey(ocr) : "";
  const cands = new Map<string, string>();
  for (const raw of materialAddresses) {
    const a = (raw ?? "").trim();
    if (!a || !hasBanchi(a)) continue;
    const k = compareKey(a);
    if (ocrKey && !k.startsWith(ocrKey)) continue;
    if (!cands.has(k)) cands.set(k, a);
  }
  if (cands.size !== 1) return null;
  return [...cands.values()][0];
}
