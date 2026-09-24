// app/lib/pickup-image-url.ts（純関数・依存なし・画面とサーバーで共用）
// 売上サポの物件で「文字のある画像」を選ぶ。
//
// 2026-09-24 竹内「文字が反映されていないバグも起きている。原因見つけて改善する」:
//   サーバーで描いた page_image_url は、直す前（pdfjs に cMap が渡っていなかった間）は表・設備欄・備考の文字が全部抜けていた。
//   その間は文字層（pdf_has_text）も同じ原因で false。直した後は両方 true になる（同じ pdfjs-assets で直した）。
//   → 文字の有無の目安に pdf_has_text を使う: トリミング（画面で描いた物・文字あり）→ 文字層が取れた回の page_image_url → 無し。
//   無しの時は画面が先に ✂️ トリミングしてから「画像で分析」する。
export type PickupImageRow = { trim_image_url?: string | null; page_image_url?: string | null; pdf_has_text?: boolean | null; pdf_blob_url?: string | null };

/** 画像で分析に渡す画像（文字のある物だけ）。無ければ null */
export function pickAnalysisImageUrl(r: PickupImageRow): string | null {
  if (r.trim_image_url) return r.trim_image_url;
  if (r.page_image_url && r.pdf_has_text) return r.page_image_url;
  return null;
}

/**
 * 分析の前に画面でトリミングが要るか（文字のある画像が無い）。
 * 2026-09-24 竹内「必要な所だけを切り出して読ませる。表の文字は文字層から」: 物件ごとの PDF（pdf_blob_url）があれば
 *   サーバーが PDF から文字層と間取り図の切り出しを作るので、トリミングは要らない（画像は PDF が無い時の予備）
 */
export function needsTrimBeforeAnalysis(r: PickupImageRow): boolean {
  if (r.pdf_blob_url) return false;
  return pickAnalysisImageUrl(r) == null;
}

/**
 * 「💾 画像保存」で手元（スマホの写真）に保存する画像。お客様に送る1ページ目（弊社帯替え）だけ。
 * 2026-09-24 竹内「画像トリミングボタンを画像保存にして、押したら選択しているのが一括で携帯に保存される形にする」:
 *   トリミング（送る形）→ 文字層が取れた回の1ページ目（page_image_url）→ 無し（null＝先にトリミングしてから保存）。
 *   ⚠ 元付業者の資料（2ページ目・agent_image_url・AD の記載あり）は**絶対に選ばない**（引数の型にも入れない）
 */
export function pickSaveImageUrl(r: { trim_image_url?: string | null; page_image_url?: string | null; pdf_has_text?: boolean | null }): string | null {
  return pickAnalysisImageUrl({ trim_image_url: r.trim_image_url, page_image_url: r.page_image_url, pdf_has_text: r.pdf_has_text });
}

/** 保存するファイル名（端末で使えない文字を外す）。「3_エスリード難波AGREA_405.jpg」 */
export function saveImageFileName(r: { rank: number; property_name: string; room_no?: string | null }, url: string): string {
  const ext = /\.png(?:$|\?)/i.test(url) ? "png" : "jpg";
  const base = `${r.rank}_${r.property_name}${r.room_no ? `_${r.room_no}` : ""}`.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
  return `${base}.${ext}`;
}
