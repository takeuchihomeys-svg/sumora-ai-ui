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
import { existsSync } from "node:fs";
import { join } from "node:path";

export type PdfRenderResult = { png: Buffer; width: number; height: number; ms: number };

function pdfjsAssetDir(sub: "cmaps" | "standard_fonts"): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("pdfjs-dist/package.json").replace(/package\.json$/, `${sub}/`);
  } catch { return undefined; }
}

/** 同梱の日本語フォント（public/fonts/NotoSansJP.ttf・OFL）。無ければ null（＝OS のフォント任せ） */
export const JP_FONT_FAMILY = "Noto Sans JP";
export function japaneseFontPath(): string | null {
  try {
    const p = join(process.cwd(), "public", "fonts", "NotoSansJP.ttf");
    return existsSync(p) ? p : null;
  } catch { return null; }
}

/** ctx.font の家族名部分（"12px" の後ろ）を同梱の日本語フォントに置き換える（純関数・テスト用に export） */
export function rewriteFontFamily(font: string, family: string = JP_FONT_FAMILY): string {
  const m = /^([\s\S]*?\d+(?:\.\d+)?(?:px|pt|em|%)\s*)([\s\S]*)$/.exec(font);
  if (!m) return font;
  return `${m[1]}"${family}", sans-serif`;
}

let jpFontRegistered: boolean | null = null;
/** フォントを1回だけ登録し、ctx.font の setter を包んで家族名を置き換える。フォントが無ければ何もしない */
export function installJapaneseFontFallback(ctx: { font: string }, fonts: { registerFromPath(path: string, alias?: string): unknown; has(name: string): boolean }): boolean {
  if (jpFontRegistered === null) {
    const p = japaneseFontPath();
    jpFontRegistered = !!p && (fonts.has(JP_FONT_FAMILY) || fonts.registerFromPath(p, JP_FONT_FAMILY) !== null);
    if (!jpFontRegistered) console.warn("[pdf-render] 日本語フォントを登録できない（public/fonts/NotoSansJP.ttf が無い）→ OS のフォント任せ");
  }
  if (!jpFontRegistered) return false;
  const proto = Object.getPrototypeOf(ctx) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, "font");
  if (!desc || !desc.set || !desc.get) return false;
  const get = desc.get, set = desc.set;
  Object.defineProperty(ctx, "font", {
    configurable: true,
    get() { return get.call(this); },
    set(v: string) { set.call(this, rewriteFontFamily(String(v))); },
  });
  return true;
}

/** base64 の PDF の page（1始まり）を PNG にする。scale は 1.5（A4 で約 890×1260px）が読み取りと容量の釣り合い */
export async function renderPdfPageToPng(input: string | Uint8Array, opts?: { page?: number; scale?: number; maxPixels?: number; systemFonts?: boolean }): Promise<PdfRenderResult | null> {
  const started = Date.now();
  try {
    const bytes = typeof input === "string" ? Uint8Array.from(Buffer.from(input, "base64")) : input;
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { createCanvas, GlobalFonts } = await import("@napi-rs/canvas");
    const cMapUrl = pdfjsAssetDir("cmaps");
    const standardFontDataUrl = pdfjsAssetDir("standard_fonts");
    const task = pdfjs.getDocument({
      data: bytes, disableWorker: true, isEvalSupported: false, useSystemFonts: false,
      ...(cMapUrl ? { cMapUrl, cMapPacked: true } : {}),
      ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
    } as Parameters<typeof pdfjs.getDocument>[0]);
    const pdf = await task.promise;
    // 無いページは null（丸めて別のページを返さない）。2026-09-24: 1ページしか無い PDF の「元付（2ページ目）」を弊社の1ページ目と取り違えないため
    const pageNo = Math.max(1, opts?.page ?? 1);
    if (pageNo > pdf.numPages) { try { await pdf.cleanup(); await task.destroy(); } catch { /* 無視 */ } return null; }
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
    // 2026-09-24 竹内「トリミングできているが中の文字が抜けている。文字もそのままある形に」:
    //   本番（Linux）には日本語フォントが無く、pdfjs が ctx.font に入れる `"g_d0_f1", serif` がどの字形にも当たらず文字が消えた
    //   （ローカルは Windows のフォントで出ていた）。同梱した Noto Sans JP（public/fonts・OFL）を登録し、ctx.font の家族名を全部それに置き換える
    //   （pdfjs は Node では FontFace を使わず、埋め込みの有無に関わらず fallback の家族名で描く＝置き換えても崩れない）
    //   systemFonts: true はパソコンのフォントで描く（Windows のテストで「画面で切る」主経路と同じ見た目を作る用）
    if (!opts?.systemFonts) installJapaneseFontFallback(ctx as unknown as { font: string }, GlobalFonts);
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
