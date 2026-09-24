// 2026-09-24 竹内「ピックアップを売上サポに飛ばして確認→送るだけ」— 純関数のテスト
// 実行: npx tsx app/lib/__tests__/property-pickups.test.ts
import { parseRecommendMark, buildPickupRows, buildCustomerPickupMessage } from "../property-pickups";
import { extractPdfText } from "../pdf-text";
import { renderPdfPageToPng } from "../pdf-render";
import { PDFDocument, StandardFonts } from "pdf-lib";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); }
  else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ""}`); }
}

console.log("── ★ 🌟 の印（merge-pdfs の rankAndAnnotateSummaries の形）");
{
  t("★ 【1🌟★】は一番オススメ", JSON.stringify(parseRecommendMark("【1🌟★】アコード中之島\n58,000円")) === JSON.stringify({ rank: 1, recommended: 2 }));
  t("★ 【2🌟】はオススメ", JSON.stringify(parseRecommendMark("【2🌟】X")) === JSON.stringify({ rank: 2, recommended: 1 }));
  t("★ 【3】は印なし", JSON.stringify(parseRecommendMark("【3】X")) === JSON.stringify({ rank: 3, recommended: 0 }));
  t("★ 見出しが無ければ順位なし", parseRecommendMark("X").rank === null);
}

console.log("── ★ 行の組み立て");
{
  const rows = buildPickupRows(
    { batchId: "物件まとめ_2026-09-24_1.pdf", propertyCustomerId: "pc1", conversationId: "c1", customerName: "YUMA", site: "realpro" },
    [
      { summary: "【1🌟★】アコード中之島 1402号室\n58,000円\n1K\nAD 2ヶ月", pdfUrl: "https://www.realnetpro.com/print/1.pdf", pdfBlobUrl: "https://blob/1.pdf", pdfText: "x".repeat(100), judgment: null },
      { summary: "【2】ドリームネオポリス桜ノ宮\n65,000円", pdfUrl: null, pdfBlobUrl: null, pdfText: null, judgment: null },
    ],
  );
  t("★ 2行・順位と🌟", rows.length === 2 && rows[0].rank === 1 && rows[0].recommended === 2 && rows[1].rank === 2 && rows[1].recommended === 0, rows.map((r) => [r.rank, r.recommended]));
  t("★ 物件名と号室は見出しから", rows[0].property_name === "アコード中之島" && rows[0].room_no === "1402" && rows[1].property_name === "ドリームネオポリス桜ノ宮");
  t("★ PDF の文字層の有無", rows[0].pdf_has_text === true && rows[1].pdf_has_text === false);
  t("★ 状態は未確認から", rows.every((r) => r.status === "pending"));
  const msg = buildCustomerPickupMessage(rows);
  t("★ お客様への本文: 番号を振り直し・🌟を残し・PDF のリンクを添える", msg.startsWith("【1🌟★】アコード中之島") && msg.includes("📄 https://blob/1.pdf") && msg.includes("【2】ドリームネオポリス桜ノ宮"), msg);
}

console.log("── ★ PDF の文字層（pdf-lib で作った PDF）");
(async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Rent 58,000  1LDK  AD 2 months", { x: 20, y: 250, size: 12, font });
  page.drawText("Bath/Toilet separate  Parking available", { x: 20, y: 220, size: 12, font });
  const b64 = Buffer.from(await doc.save()).toString("base64");
  const r = await extractPdfText(b64, { maxPages: 1 });
  t("★ 文字が取れる・行が分かれる", r.hasText && r.text.includes("Rent 58,000") && r.text.includes("\n") && r.pages === 1, r);
  const bad = await extractPdfText("not-a-pdf");
  t("★ 壊れた入力は投げずに空", bad.text === "" && bad.hasText === false);
  // 2026-09-24 竹内「PDF の文字だけではよくない。資料を読み取れる形に」: 1ページ目を PNG にする
  const png = await renderPdfPageToPng(b64, { page: 1, scale: 1.5 });
  t("★ 1ページ目が PNG になる（PNG の印・幅高さ）", !!png && png.png.length > 1000 && png.png[0] === 0x89 && png.png[1] === 0x50 && png.width > 500 && png.height > 300, png ? { bytes: png.png.length, w: png.width, h: png.height, ms: png.ms } : null);
  const bigPng = await renderPdfPageToPng(b64, { page: 1, scale: 8 });
  t("★ 大きすぎる指定でも画素数の上限に収める（約200万画素）", !!bigPng && bigPng.width * bigPng.height <= 2_100_000, bigPng ? { w: bigPng.width, h: bigPng.height } : null);
  t("★ 壊れた入力は null（判定は文字層だけで進む）", (await renderPdfPageToPng("not-a-pdf")) === null);
  console.log(`\n合計: ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
})();
