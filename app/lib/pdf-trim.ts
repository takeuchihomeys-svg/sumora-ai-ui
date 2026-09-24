// app/lib/pdf-trim.ts
// 物件資料（リアプロの印刷用 PDF の1ページ目＝弊社に帯替えした面）を、お客様に実際に送っている形にトリミングする。
//
// 2026-09-24 竹内「画像トリミングボタンを付ける。押すと選択している物件の PDF 1枚目（弊社帯替え分）がトリミングされて
//   画像となって送られるようにする。画像の形は実際にお客さんに送ってる形（あれはトリミングしたもの）」
//
// 実物で確かめた形（messages のスタッフ送信画像 2026-09-24・パレ城北 1324×790 ≒ 元の 1548×1093 の上 84.5%）:
//   リアプロの印刷用シートは A4 横で、下端に **会社の帯**（免許番号・会社名・住所・TEL・出力日）が固定の高さで入る。
//   お客様に送っている画像はその帯を落とした「上の部分」＝ 物件の表・写真・間取り図・地図・特記事項。
//   帯の上の罫線は 1093px 中 y≈945（86.5%）。帯に食い込まないよう 86% で切る（条件の行は残る）。
//   左右は切らない（元の幅のまま）。
// 2026-09-24 竹内「トリミングは縦横100%でも大丈夫。PDF 1枚目は帯替えされているから（下の帯は弊社）。元付業者の資料は送らない」
//   → 既定は 100%（切らない）。上の 86% は実送信から測った値として残す（必要なら keepRatio で渡す）
//   矩形の計算はブラウザと共用するので依存なしの pdf-trim-rect.ts に置く（ここは @napi-rs/canvas を使うサーバー専用）
import { cropRectForSheet } from "./pdf-trim-rect";
export { cropRectForSheet, REALPRO_SHEET_KEEP_RATIO, REALPRO_SHEET_TRIM_RATIO_MEASURED, type CropRect } from "./pdf-trim-rect";

/** PNG/JPEG のバッファをトリミングして JPEG にする（LINE は JPEG/PNG どちらも可・JPEG の方が小さい）。失敗は null */
export async function trimSheetImage(image: Buffer, opts?: { keepRatio?: number; quality?: number }): Promise<{ jpeg: Buffer; width: number; height: number } | null> {
  try {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(image);
    const rect = cropRectForSheet(img.width, img.height, opts?.keepRatio);
    const canvas = createCanvas(rect.width, rect.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const jpeg = canvas.toBuffer("image/jpeg", opts?.quality ?? 88);
    return { jpeg, width: rect.width, height: rect.height };
  } catch (e) {
    console.warn("[pdf-trim] トリミングできない:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
