// app/lib/pdf-trim-browser.ts（ブラウザ専用）
// 物件資料の PDF 1ページ目を、スタッフのパソコンの上でそのまま画像にしてトリミングする。
//
// 2026-09-24 竹内「何で元の物件資料で共有できないのか。元の物件資料をトリミングすれば良いだけ」
//   リアプロの印刷用 PDF はフォントを中に持っておらず（埋め込みなし）、開いたパソコンのフォントで文字を描く。
//   サーバー（Linux）には日本語フォントが無く文字が抜け、同梱フォントで描くと書体が変わる。
//   スタッフの Windows のブラウザで描けば、いつも見ている資料と同じ見た目になる → 画面側で描いて切り、画像だけサーバーに置く。
// pdf.js の worker・CMap・標準フォントは public/pdfjs に置いた物を使う（pdfjs-dist 6.3.289 と同じ版。上げたらコピーし直す）
// ⚠ ./pdf-trim（サーバー専用・@napi-rs/canvas）を import しない。画面のビルドに fs が引き込まれて本番ビルドが落ちる
import { cropRectForSheet } from "./pdf-trim-rect";

export const PDFJS_PUBLIC_BASE = "/pdfjs/";

/** PDF（URL）の page ページを描いて上 keepRatio を切り、JPEG の Blob を返す */
export async function trimPdfPageInBrowser(pdfUrl: string, opts?: { page?: number; scale?: number; keepRatio?: number; quality?: number }): Promise<Blob> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_PUBLIC_BASE}pdf.worker.min.mjs`;
  const res = await fetch(pdfUrl);
  if (!res.ok) throw new Error(`資料を取れない（HTTP ${res.status}）`);
  const data = new Uint8Array(await res.arrayBuffer());
  const task = pdfjs.getDocument({
    data,
    cMapUrl: `${PDFJS_PUBLIC_BASE}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${PDFJS_PUBLIC_BASE}standard_fonts/`,
    useSystemFonts: true,   // パソコンのフォント（MS ゴシック等）で描く＝元の資料と同じ見た目
  });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(Math.min(Math.max(1, opts?.page ?? 1), pdf.numPages));
    const viewport = page.getViewport({ scale: opts?.scale ?? 2 });
    const full = document.createElement("canvas");
    full.width = Math.ceil(viewport.width); full.height = Math.ceil(viewport.height);
    const ctx = full.getContext("2d");
    if (!ctx) throw new Error("canvas が使えない");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, full.width, full.height);
    // 2026-09-24 竹内「文字が反映されていないバグ」: iPhone には MS ゴシックが無い。pdfjs は汎用名（sans-serif＝ヒラギノ）に落として描く見込みだが
    //   実機では確かめていない → 描いた文字の数を数え、資料に文字があるのに 0 なら投げる（呼び出し側がサーバーで描く予備に回す。
    //   サーバーは同梱の Noto Sans JP で描き、cMap の不具合も直した）。「白い表」の画像を黙って送らない
    let textDraws = 0;
    const origFill = ctx.fillText.bind(ctx), origStroke = ctx.strokeText.bind(ctx);
    ctx.fillText = (...a: Parameters<CanvasRenderingContext2D["fillText"]>) => { textDraws++; origFill(...a); };
    ctx.strokeText = (...a: Parameters<CanvasRenderingContext2D["strokeText"]>) => { textDraws++; origStroke(...a); };
    await page.render({ canvasContext: ctx, viewport, canvas: full }).promise;
    if (textDraws === 0) {
      const tc = await page.getTextContent().catch(() => null);
      const chars = (tc?.items ?? []).reduce((n, it) => n + ("str" in it ? String(it.str).trim().length : 0), 0);
      if (chars >= 40) throw new Error(`文字が描けない（資料の文字 ${chars}字・描いた文字 0）`);
    }
    const r = cropRectForSheet(full.width, full.height, opts?.keepRatio);
    const out = document.createElement("canvas");
    out.width = r.width; out.height = r.height;
    const octx = out.getContext("2d");
    if (!octx) throw new Error("canvas が使えない");
    octx.drawImage(full, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
    return await new Promise<Blob>((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("画像にできない"))), "image/jpeg", opts?.quality ?? 0.9));
  } finally {
    try { await task.destroy(); } catch { /* 無視 */ }
  }
}

/** Blob → base64（data: の前置きなし） */
export async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}
