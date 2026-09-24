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
    return {
      batch_id: batch.batchId,
      property_customer_id: batch.propertyCustomerId,
      conversation_id: batch.conversationId,
      customer_name: batch.customerName,
      site: batch.site,
      rank: mark.rank ?? i + 1,
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
      reasons_ja: j ? j.reasonsJa : null,
      ad_yen: j?.adYen ?? null,
      profit_yen: j?.profitYen ?? null,
      recommended: mark.recommended,
      status: "pending",
      page_image_url: it.pageImageUrl ?? null,
      agent_image_url: it.agentImageUrl ?? null,
      image_lines: it.imageLines && it.imageLines.length ? it.imageLines : null,
      image_facts: it.imageFacts ?? null,
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

/** 元付資料の文字から AD を読む（「AD 2ヶ月」「AD100%」「広告料 1ヶ月」「AD 50,000円」）。数値は表の文字が正だが、AD は元付の資料にしか無い事が多い */
export function parseAdFromText(text: string | null | undefined): { adMonths: number | null; adYen: number | null } {
  const t = String(text ?? "").replace(/[０-９．，]/g, (c) => c === "．" ? "." : c === "，" ? "," : String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/,/g, "");
  const m = t.match(/(?:AD|ＡＤ|広告料|広告費)\s*[:：]?\s*(?:家賃|賃料)?\s*(\d+(?:\.\d+)?)\s*(?:ヶ月|ヵ月|カ月|か月|ケ月|ヶ|%|％)/i);
  if (m) {
    const v = parseFloat(m[1]);
    const isPct = /[%％]\s*$/.test(m[0]);
    const months = isPct ? v / 100 : v;
    return months > 0 && months <= 12 ? { adMonths: months, adYen: null } : { adMonths: null, adYen: null };
  }
  const y = t.match(/(?:AD|ＡＤ|広告料|広告費)\s*[:：]?\s*(\d{4,7})\s*円/i);
  if (y) return { adMonths: null, adYen: parseInt(y[1], 10) };
  return { adMonths: null, adYen: null };
}

/** お客様に送る本文（選んだ物件の説明文を番号を振り直して並べ、PDF のリンクを添える） */
export function buildCustomerPickupMessage(rows: ReadonlyArray<Pick<PickupRow, "summary_text" | "pdf_blob_url" | "recommended">>): string {
  const lines: string[] = [];
  rows.forEach((r, i) => {
    const body = r.summary_text.replace(/^【\d+[^】]*】\s*/u, "");
    lines.push(`【${i + 1}${r.recommended === 2 ? "🌟★" : r.recommended === 1 ? "🌟" : ""}】${body}`);
    if (r.pdf_blob_url) lines.push(`📄 ${r.pdf_blob_url}`);
    lines.push("");
  });
  return lines.join("\n").trim();
}
