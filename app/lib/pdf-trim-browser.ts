// app/lib/pdf-trim-browser.ts（ブラウザ専用）
// 物件資料の PDF の奇数ページ（1ページ目＝弊社帯の面）を、スタッフの端末の上で**そのまま**画像にする（切り取らない・書体を差し替えない）。
//
// 2026-09-24 竹内「何で元の物件資料で共有できないのか。元の物件資料をトリミングすれば良いだけ」
//   リアプロの印刷用 PDF はフォント（MS ゴシック）を中に持っておらず（埋め込みなし）、開いた端末のフォントで文字を描く。
//   サーバー（Linux）には日本語フォントが無く、同梱フォント（Noto Sans JP）で描くと書体が変わる。
//   スタッフの Windows のブラウザで描けば、いつも見ている資料と同じ見た目になる → 画面側で描き、画像だけサーバーに置く。
// 2026-09-27 竹内「物件はいま文字とか入れなおしてるけど、そのままの画像つかったら大丈夫」:
//   ①切り取りをやめた（ページ全体・旧は keepRatio で上を残す作り＝既定 100% だったが道は残っていた）
//   ②端末に資料の書体が無い時（iPhone 等）は、別の書体に差し替えた画像を作らずに投げる（旧は文字が1つでも描ければ通していた）。
//     書体があるかは pdfjs が「端末の書体で描く」と決めた書体（fontExtraProperties の fontSubstitution）ごとに、文字の幅で測る。
//     埋め込みの書体（itandi）は端末に関係なく元の字形なので測らない。判定は純関数 judgeOriginalRender（pickup-send-image.ts）
// pdf.js の worker・CMap・標準フォントは public/pdfjs に置いた物を使う（pdfjs-dist 6.3.289 と同じ版。上げたらコピーし直す）
// ⚠ ./pdf-trim（サーバー専用・@napi-rs/canvas）を import しない。画面のビルドに fs が引き込まれて本番ビルドが落ちる
import { judgeOriginalRender, requestedSystemFamilies, SEND_PAGE } from "./pickup-send-image";

export const PDFJS_PUBLIC_BASE = "/pdfjs/";

/** 端末に書体が無くて元の資料と同じ文字で描けない（呼び出し側はサーバーの予備に回すか、スタッフに伝える） */
export class OriginalFontMissingError extends Error {
  readonly missing: string[];
  constructor(message: string, missing: string[]) { super(message); this.name = "OriginalFontMissingError"; this.missing = missing; }
}

/**
 * その書体が端末にあるか（文字の幅で測る）。総称の書体を3つ当て、どれか1つでも幅が変われば「ある」。
 * 例: 日本語の Windows の Chrome は monospace＝MS ゴシックなので monospace では変わらないが、serif（明朝）で変わる
 */
export function isLocalFontFamilyAvailable(family: string): boolean {
  const c = document.createElement("canvas").getContext("2d");
  if (!c) return false;
  const sample = "物件名 賃料 wiIl1 0123 ｱｲｳ 難波ＷＩ";
  for (const base of ["monospace", "serif", "sans-serif"]) {
    c.font = `40px ${base}`;
    const w0 = c.measureText(sample).width;
    c.font = `40px "${family.replace(/"/g, "")}", ${base}`;
    if (c.measureText(sample).width !== w0) return true;
  }
  return false;
}

/** PDF（URL）の送る面（奇数ページ＝弊社帯）をそのまま描いて JPEG の Blob を返す。書体を差し替えないと描けない時は OriginalFontMissingError */
export async function renderOriginalPageInBrowser(pdfUrl: string, opts?: { page?: number; scale?: number; quality?: number }): Promise<Blob> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_PUBLIC_BASE}pdf.worker.min.mjs`;
  const res = await fetch(pdfUrl);
  if (!res.ok) throw new Error(`資料を取れない（HTTP ${res.status}）`);
  const data = new Uint8Array(await res.arrayBuffer());
  const task = pdfjs.getDocument({
    data,
    cMapUrl: `${PDFJS_PUBLIC_BASE}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${PDFJS_PUBLIC_BASE}standard_fonts/`,
    useSystemFonts: true,        // 端末のフォント（MS ゴシック等）で描く＝元の資料と同じ見た目
    fontExtraProperties: true,   // どの書体を端末の書体で描いたか（fontSubstitution）を文字層に出す
  });
  try {
    const pdf = await task.promise;
    const pageNo = opts?.page ?? SEND_PAGE;
    if (pageNo < 1 || pageNo > pdf.numPages) throw new Error(`資料に ${pageNo} ページが無い（${pdf.numPages} ページ）`);
    const page = await pdf.getPage(pageNo);
    const viewport = page.getViewport({ scale: opts?.scale ?? 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas が使えない");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    let textDraws = 0;
    const origFill = ctx.fillText.bind(ctx), origStroke = ctx.strokeText.bind(ctx);
    ctx.fillText = (...a: Parameters<CanvasRenderingContext2D["fillText"]>) => { textDraws++; origFill(...a); };
    ctx.strokeText = (...a: Parameters<CanvasRenderingContext2D["strokeText"]>) => { textDraws++; origStroke(...a); };
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const tc = await page.getTextContent().catch(() => null);
    const textChars = (tc?.items ?? []).reduce((n, it) => n + ("str" in it ? String(it.str).trim().length : 0), 0);
    const requested = requestedSystemFamilies((tc?.styles ?? {}) as Record<string, { fontSubstitution?: string }>);
    const judge = judgeOriginalRender({ requested, available: isLocalFontFamilyAvailable, textChars, textDraws });
    if (!judge.ok) throw new OriginalFontMissingError(judge.message, judge.missing);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像にできない"))), "image/jpeg", opts?.quality ?? 0.9));
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
