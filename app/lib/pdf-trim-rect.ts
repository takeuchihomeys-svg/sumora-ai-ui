// app/lib/pdf-trim-rect.ts
// 物件資料のトリミングの「矩形の計算」だけ（純関数・何も import しない）。
// ⚠ 2026-09-24: ブラウザ側（pdf-trim-browser.ts）がサーバー用の pdf-trim.ts を import していたため、@napi-rs/canvas（fs を使う）が
//   画面のビルドに引き込まれ、本番のビルドが3回続けて失敗した（Module not found: Can't resolve 'fs'）。型チェックでは見つからない。
//   → 画面とサーバーの両方が使う物は、ここ（依存なし）に置く。
// 2026-09-24 竹内「トリミングは縦横100%でも大丈夫。PDF 1枚目は帯替えされているから（下の帯は弊社）」
//   → 既定は 100%（切らない）。実送信から測った 86% は REALPRO_SHEET_TRIM_RATIO_MEASURED として残す
export const REALPRO_SHEET_TRIM_RATIO_MEASURED = 0.86;
export const REALPRO_SHEET_KEEP_RATIO = 1.0;

export type CropRect = { x: number; y: number; width: number; height: number };

/** 上から keepRatio の高さを残す矩形（境界: 1px 以上を保証） */
export function cropRectForSheet(width: number, height: number, keepRatio: number = REALPRO_SHEET_KEEP_RATIO): CropRect {
  const r = Number.isFinite(keepRatio) && keepRatio > 0 && keepRatio <= 1 ? keepRatio : REALPRO_SHEET_KEEP_RATIO;
  const h = Math.max(1, Math.min(height, Math.round(height * r)));
  return { x: 0, y: 0, width: Math.max(1, width), height: h };
}
