// app/lib/pdf-render.ts
// PDF の1ページを PNG にする（pdfjs-dist ＋ @napi-rs/canvas・Node 専用）。
//
// 2026-09-24 竹内「PDF の文字だけではよくない。物件資料が掲載されているのだから、その資料を読み取れる形にしたい」
//   DeepSeek は画像（JPEG/PNG/GIF/WebP）だけを受けるので、印刷用 PDF の1ページ目を画像にして渡す。
//   LINE も画像の URL なら送れる（PDF は送れない）ので、お客様に「資料の画像」を送る道にもなる。
//
// ⚠ 日本語: PDF にフォントが埋め込まれていない時は pdfjs の標準フォント（standard_fonts）と CMap（cmaps）が要る。
//   next.config.ts の outputFileTracingIncludes で同梱する。無ければ文字が抜けた画像になる（落ちはしない）。
// ⚠ 失敗は null（呼び出し側は文字層だけで進む）。
import { createRequire } from "node:module";

export type PdfRenderResult = { png: Buffer; width: number; height: number; ms: number };

function pdfjsAssetDir(sub: "cmaps" | "standard_fonts"): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("pdfjs-dist/package.json").replace(/package\.json$/, `${sub}/`);
  } catch { return undefined; }
}

/** base64 の PDF の page（1始まり）を PNG にする。scale は 1.5（A4 で約 890×1260px）が読み取りと容量の釣り合い */
export async function renderPdfPageToPng(input: string | Uint8Array, opts?: { page?: number; scale?: number; maxPixels?: number }): Promise<PdfRenderResult | null> {
  const started = Date.now();
  try {
    const bytes = typeof input === "string" ? Uint8Array.from(Buffer.from(input, "base64")) : input;
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { createCanvas } = await import("@napi-rs/canvas");
    const cMapUrl = pdfjsAssetDir("cmaps");
    const standardFontDataUrl = pdfjsAssetDir("standard_fonts");
    const task = pdfjs.getDocument({
      data: bytes, disableWorker: true, isEvalSupported: false, useSystemFonts: false,
      ...(cMapUrl ? { cMapUrl, cMapPacked: true } : {}),
      ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
    } as Parameters<typeof pdfjs.getDocument>[0]);
    const pdf = await task.promise;
    const pageNo = Math.min(Math.max(1, opts?.page ?? 1), pdf.numPages);
    const page = await pdf.getPage(pageNo);
    let scale = opts?.scale ?? 1.5;
    let viewport = page.getViewport({ scale });
    const maxPixels = opts?.maxPixels ?? 2_000_000;   // 約 1400×1400。DeepSeek の入力と Blob の容量の釣り合い
    if (viewport.width * viewport.height > maxPixels) {
      scale = scale * Math.sqrt(maxPixels / (viewport.width * viewport.height));
      viewport = page.getViewport({ scale });
    }
    const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height);
    // pdfjs の型は DOM の canvas を想定しているので、@napi-rs/canvas を同じ形として渡す
    await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas: canvas as unknown as HTMLCanvasElement }).promise;
    const png = canvas.toBuffer("image/png");
    try { page.cleanup(); await pdf.cleanup(); await task.destroy(); } catch { /* 片付けの失敗は無視 */ }
    return { png, width, height, ms: Date.now() - started };
  } catch (e) {
    console.warn("[pdf-render] 画像にできない:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
