// app/lib/property-pickups.ts
// 物件ピックアップの1回分（バッチ）を「売上サポ」で確認して送るための行を作る（純関数・DB 依存なし）。
//
// 2026-09-24 竹内「ピックアップしたのを一度アプリの売上サポの部分に飛ばして、LINE のトーク一覧のように並べ、
//   送る物件とその中のオススメを DeepSeek が判断して共有。スタッフは確認してお客さんに送るだけ」
//
// ここで決める事:
//   ・1回分の鍵（batch_id）: merge-pdfs が Blob に置く結合 PDF の名前（一意）
//   ・行 ＝ 物件1件（説明文・PDF の文字層・判定・🌟オススメ・PDF の URL）
//   ・🌟 の印は merge-pdfs の rankAndAnnotateSummaries が説明文の先頭に付ける「【1🌟★】」「【2🌟】」をそのまま読む（別の判断を作らない）
import { parseSummaryHead } from "./sent-property-filter";
import type { Judgment } from "./property-brain";
import type { PickupEquipment } from "./pickup-equipment";
import type { PickupTerms } from "./pickup-terms";
import type { PickupLocation } from "./area-want";

export type PickupItemInput = {
  /** 番号付きの説明文（🌟 付きならそれ） */
  summary: string;
  /** 印刷用 PDF の URL（リアプロ・cookie が要る） */
  pdfUrl: string | null;
  /** 物件ごとの PDF を Blob に置いた URL（公開・スタッフが開く用） */
  pdfBlobUrl: string | null;
  /** PDF の文字層（先頭 maxChars） */
  pdfText: string | null;
  judgment: Judgment | null;
  /** 2026-09-24 竹内「資料を読み取れる形に」: 1ページ目を画像にした Blob の URL と、DeepSeek が画像から読んだ中身 */
  pageImageUrl?: string | null;
  /** 元付業者の資料（偶数ページ）の画像。AD・条件を読む用（お客様には送らない） */
  agentImageUrl?: string | null;
  imageLines?: string[] | null;
  imageFacts?: Record<string, boolean | null> | null;
  /** 2026-09-24 資料の設備欄 × お客様の条件の照合（pickup-equipment.ts の PickupEquipment） */
  equipment?: PickupEquipment | null;
  /** 2026-09-25 資料の表の募集の条件（敷礼・築年・入居時期・契約・更新料・入居の条件）と希望の照合（pickup-terms.ts） */
  terms?: PickupTerms | null;
  /** 2026-09-25 物件の場所（交通・所在地）と希望のエリア・通勤の照合（area-want.ts の PickupLocation） */
  location?: PickupLocation | null;
  /**
   * 2026-09-24 竹内「同じ建物だと平米数2㎡以内だと家賃がひくい部屋をここにいれて、他の部屋は売上サポに飛ばさなくて大丈夫」:
   *   pickup-dedupe.ts で落とした部屋に 🌟/🌟★ が付いていた時、残した部屋に引き継ぐ印（説明文の印と強い方を採る）
   */
  recommendedOverride?: number | null;
  /** 判定の理由に足す一文（例「同じ建物の近い広さの部屋を 7件省略」） */
  extraReasonsJa?: string[] | null;
  /**
   * 説明文に【N】が無い時の順位（元の並びの番号・1始まり）。2026-09-24: 同じ建物の重複を落とすと items が詰まり、
   *   i + 1 だと LINE グループの番号とずれる → 呼び出し側が元の番号を渡す
   */
  fallbackRank?: number | null;
};

export type PickupRow = {
  batch_id: string;
  property_customer_id: string | null;
  conversation_id: string | null;
  customer_name: string | null;
  site: string | null;
  rank: number;
  property_name: string;
  room_no: string | null;
  summary_text: string;
  pdf_url: string | null;
  pdf_blob_url: string | null;
  pdf_text: string | null;
  pdf_has_text: boolean;
  verdict: string | null;
  score: number | null;
  reason_codes: string[] | null;
  reasons_ja: string[] | null;
  ad_yen: number | null;
  profit_yen: number | null;
  /** 0=印なし・1=🌟・2=🌟★（一番オススメ） */
  recommended: number;
  status: "pending";
  page_image_url: string | null;
  agent_image_url: string | null;
  image_lines: string[] | null;
  image_facts: Record<string, boolean | null> | null;
  equipment: PickupEquipment | null;
  terms: PickupTerms | null;
  location?: PickupLocation | null;
};

/** 説明文の先頭「【1🌟★】」から順位と印を読む */
export function parseRecommendMark(summary: string): { rank: number | null; recommended: number } {
  const m = String(summary ?? "").match(/^【(\d+)([^】]*)】/u);
  if (!m) return { rank: null, recommended: 0 };
  const marks = m[2];
  const recommended = /★/.test(marks) ? 2 : /🌟/u.test(marks) ? 1 : 0;
  return { rank: parseInt(m[1], 10), recommended };
}

export function buildPickupRows(
  batch: { batchId: string; propertyCustomerId: string | null; conversationId: string | null; customerName: string | null; site: string | null },
  items: ReadonlyArray<PickupItemInput>,
): PickupRow[] {
  return items.map((it, i) => {
    const head = parseSummaryHead(it.summary);
    const mark = parseRecommendMark(it.summary);
    const j = it.judgment;
    const extra = (it.extraReasonsJa ?? []).filter(Boolean);
    // 足す一文（同じ建物の省略）は先頭に（画面は reasons_ja の先頭3つだけ出すので、後ろだと隠れる）
    const reasons = [...extra, ...(j ? j.reasonsJa : [])];
    return {
      batch_id: batch.batchId,
      property_customer_id: batch.propertyCustomerId,
      conversation_id: batch.conversationId,
      customer_name: batch.customerName,
      site: batch.site,
      rank: mark.rank ?? it.fallbackRank ?? i + 1,
      property_name: head?.propertyName || j?.name || "物件",
      room_no: head?.roomNo || null,
      summary_text: it.summary,
      pdf_url: it.pdfUrl,
      pdf_blob_url: it.pdfBlobUrl,
      pdf_text: it.pdfText,
      pdf_has_text: !!(it.pdfText && it.pdfText.length >= 40),
      verdict: j?.verdict ?? null,
      score: j?.score ?? null,
      reason_codes: j ? j.reasonCodes : null,
      reasons_ja: j || extra.length ? reasons : null,
      ad_yen: j?.adYen ?? null,
      profit_yen: j?.profitYen ?? null,
      recommended: Math.max(mark.recommended, it.recommendedOverride ?? 0),
      status: "pending",
      page_image_url: it.pageImageUrl ?? null,
      agent_image_url: it.agentImageUrl ?? null,
      image_lines: it.imageLines && it.imageLines.length ? it.imageLines : null,
      image_facts: it.imageFacts ?? null,
      equipment: it.equipment ?? null,
      terms: it.terms ?? null,
      // 場所の照合が無い行は列を出さない（列を足す前の DB にも書ける）
      ...(it.location ? { location: it.location } : {}),
    };
  });
}

/**
 * 2026-09-24 竹内「1ページ目は弊社に帯替えされた資料、2ページ目が元付業者の資料でそこに AD の記載がある。
 *   奇数＝弊社・偶数＝元付 の組。偶数ページを画像として判断すればより正確」
 * → 印刷用 PDF は物件ごとに「1: 弊社（お客様に送る）／2: 元付（AD・条件を読む）」の2ページ組。
 */
export const CUSTOMER_PAGE = 1;
export const AGENT_PAGE = 2;

/**
 * 元付資料の文字から AD を読む（「AD 2ヶ月」「AD100%」「広告料 1ヶ月」「AD 50,000円」）。数値は表の文字が正だが、AD は元付の資料にしか無い事が多い。
 * 2026-09-25 監査（任務A）:
 *   E1 リアプロの元付資料は「A D 250%(税込)」「A D 10000円」「A D 2ヶ月(税込)」と A と D の間に空白がある（19件すべて）→ `A\s?D` で読む
 *   E2 itandi の「広告費 なし」は AD 0（adMonths: 0）。読めない（null）と分ける（旧は不明扱いで AD 0.5ヶ月より上に並んでいた）
 *   「広告掲載 可」は AD ではない（「広告費」「広告料」だけ）
 */
const AD_LABEL = String.raw`(?:(?<![A-Za-z])A\s?D(?![A-Za-z])|広告料|広告費)`;
const AD_MONTHS_RE = new RegExp(`${AD_LABEL}\\s*[:：]?\\s*(?:家賃|賃料)?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:ヶ月|ヵ月|カ月|か月|ケ月|ヶ|%)`, "i");
const AD_YEN_RE = new RegExp(`${AD_LABEL}\\s*[:：]?\\s*(\\d{4,7})\\s*円`, "i");
const AD_NONE_RE = new RegExp(`${AD_LABEL}\\s*[:：]?\\s*(?:なし|無し|無(?![料])|0\\s*(?:%|ヶ月|ヵ月|カ月|か月|円)?(?![\\d.]))`, "i");
export function parseAdFromText(text: string | null | undefined): { adMonths: number | null; adYen: number | null } {
  const t = String(text ?? "")
    .replace(/[０-９Ａ-Ｚａ-ｚ．，％：]/g, (c) => c === "．" ? "." : c === "，" ? "," : c === "％" ? "%" : c === "：" ? ":" : String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/,/g, "");
  const m = t.match(AD_MONTHS_RE);
  if (m) {
    const v = parseFloat(m[1]);
    const isPct = /%\s*$/.test(m[0]);
    const months = isPct ? v / 100 : v;
    if (months === 0) return { adMonths: 0, adYen: null };
    return months > 0 && months <= 12 ? { adMonths: months, adYen: null } : { adMonths: null, adYen: null };
  }
  const y = t.match(AD_YEN_RE);
  if (y) return { adMonths: null, adYen: parseInt(y[1], 10) };
  if (AD_NONE_RE.test(t)) return { adMonths: 0, adYen: null };
  return { adMonths: null, adYen: null };
}

// 2026-09-24 夜 竹内「お客さんに送る時これ送られてないようにする」: 説明文（summary_text＝AD・🌟★・家賃の生の文）を
//   お客様向けの本文に変える関数（旧 buildCustomerPickupMessage）は消した。説明文は社内用。お客様への本文は AIX【物件ピックアップした】が作る。

/** POST /api/property-pickups/send の action の扱い。LINE に送る分岐は無い（send・未指定・知らない値は gone＝410） */
export type PickupSendActionKind = "skip" | "mark_sent" | "gone";
export function classifyPickupSendAction(action: unknown): PickupSendActionKind {
  if (action === "skip") return "skip";
  if (action === "mark_sent") return "mark_sent";
  return "gone";
}
export const PICKUP_DIRECT_SEND_GONE_MESSAGE = "お客様への送信は AIX【物件ピックアップした】から行います（直接の送信は止めました）";

/** AIX【物件ピックアップした】に渡す1件（GET /api/property-pickups?ids=）。画像の URL と見出しだけ。説明文（AD・🌟）・元付の資料は渡さない */
export type PickupHandoffItem = { id: number; rank: number; property_name: string; room_no: string | null; conversation_id: string | null; image_url: string | null };
export function toPickupHandoffItem(r: { id: number; rank: number; property_name: string; room_no: string | null; conversation_id: string | null; trim_image_url: string | null; page_image_url: string | null }): PickupHandoffItem {
  // 余分な列（summary_text・agent_image_url 等）が来ても拾わないよう、返す鍵を列挙する
  return { id: r.id, rank: r.rank, property_name: r.property_name, room_no: r.room_no, conversation_id: r.conversation_id, image_url: r.trim_image_url ?? r.page_image_url };
}
