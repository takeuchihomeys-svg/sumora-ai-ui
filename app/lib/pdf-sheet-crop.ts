// app/lib/pdf-sheet-crop.ts（サーバー専用・pdfjs-dist ＋ @napi-rs/canvas ＋ node:crypto。画面側から import しない）
// 物件資料の PDF 1ページ目から「文字層（ページごと）」「画像の位置（描画命令）」「描いた画像」を1回の読み込みで取り、
// 決めた範囲（sheet-layout.planSheetCrop）を JPEG に切り出す。
//
// 2026-09-24 竹内「必要な所（間取り図・室内写真）だけを切り出して読ませる。表の文字は PDF の文字層から取る」
//   - 画像の位置は pdfjs の描画命令（paintImageXObject 等）と変換行列から求める（リアプロは PDF 16件で小数3桁まで同じだった）
//   - ページ全体（約991トークン）→ 間取り図だけ（約185トークン）。画像のトークンは大きさにほとんど左右されない（433px も 400px も 185）
//     ので、縮めて入力を減らす効果は無い。切り出しが効く
//   - 切り出した画素のハッシュ（fp_hash）で、同じ図の部屋（同じ棟・同じ型）は読み直さない。
//     ⚠ 近い画像を同じと見なすハッシュ（dHash）は使わない: 反転タイプや帖数だけ違う図を取り違えると、別の部屋の事実を使い回す（誤共有を0にする側）
import { createHash } from "node:crypto";
import { pdfjsAssetParams } from "./pdfjs-assets";
import { installJapaneseFontFallback } from "./pdf-render";
import { textItemsToLines } from "./pdf-text";
import { toPixelRect, findItandiFrameBox, type NormBox } from "./sheet-layout";

/** 描く倍率（A4 横 1032×729pt → 2580×1821px）。間取り図の帖数の小さな字が読める大きさ */
export const SHEET_RENDER_SCALE = 2.5;
/** 切り出しの長い辺（DeepSeek の画像は大きさでトークンがほぼ変わらない・送る量だけ抑える） */
export const SHEET_CROP_MAX_SIDE = 1000;

type CanvasLike = { width: number; height: number; getContext(k: "2d"): unknown; toBuffer(mime: "image/jpeg", q?: number): Buffer };

export type SheetPdfRead = {
  /** ページごとの文字（最大 textPages ページ） */
  texts: string[];
  pages: number;
  /** 1ページ目の画像の位置（比率）。背景も含む（planSheetCrop が外す） */
  boxes: NormBox[];
  /** 高さ÷幅 */
  aspect: number;
  /** 描いた1ページ目（render: false の時は null） */
  canvas: CanvasLike | null;
  ms: number;
};

type Mat = [number, number, number, number, number, number];
const mul = (m: Mat, n: number[]): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

/** 描画命令の並びから画像の位置を求める（テスト用に export・pdfjs の OPS を渡す） */
export function imageBoxesFromOps(
  ops: { fnArray: number[]; argsArray: unknown[] },
  OPS: Record<string, number>,
  toViewport: (x: number, y: number) => [number, number],
  size: { width: number; height: number },
): NormBox[] {
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject].filter((x) => typeof x === "number"));
  let ctm: Mat = [1, 0, 0, 1, 0, 0];
  const stack: Mat[] = [];
  const out: NormBox[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const a = ops.argsArray[i] as unknown[] | null;
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform && Array.isArray(a)) ctm = mul(ctm, a as number[]);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = Array.isArray(a) ? (a[0] as ArrayLike<number> | null) : null;
      if (m && m.length === 6) ctm = mul(ctm, Array.from(m));
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (imageOps.has(fn)) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => toViewport(ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]));
      const xs = pts.map((p) => p[0] / size.width), ys = pts.map((p) => p[1] / size.height);
      const x = Math.min(...xs), y = Math.min(...ys);
      out.push({ x: Math.max(0, x), y: Math.max(0, y), w: Math.max(...xs) - x, h: Math.max(...ys) - y });
    }
  }
  return out;
}

/** PDF を1回読み、文字層（ページごと）・1ページ目の画像の位置・（render の時）描いた1ページ目を返す。失敗は null */
export async function readSheetPdf(input: Uint8Array, opts?: { render?: boolean; scale?: number; textPages?: number }): Promise<SheetPdfRead | null> {
  const started = Date.now();
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({
      data: input.slice(), disableWorker: true, isEvalSupported: false, useSystemFonts: false, ...pdfjsAssetParams(),
    } as Parameters<typeof pdfjs.getDocument>[0]);
    const pdf = await task.promise;
    const texts: string[] = [];
    for (let p = 1; p <= Math.min(pdf.numPages, opts?.textPages ?? 2); p++) {
      const pg = await pdf.getPage(p);
      const tc = await pg.getTextContent();
      texts.push(textItemsToLines(tc.items as Array<{ str?: string; transform?: number[] }>).join("\n").replace(/[ \t]+/g, " ").trim());
    }
    const page = await pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const ol = await page.getOperatorList();
    const boxes = imageBoxesFromOps(ol as unknown as { fnArray: number[]; argsArray: unknown[] }, pdfjs.OPS as unknown as Record<string, number>,
      (x, y) => vp1.convertToViewportPoint(x, y) as [number, number], { width: vp1.width, height: vp1.height });
    let canvas: CanvasLike | null = null;
    if (opts?.render !== false) {
      const { createCanvas, GlobalFonts } = await import("@napi-rs/canvas");
      const vp = page.getViewport({ scale: opts?.scale ?? SHEET_RENDER_SCALE });
      const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      installJapaneseFontFallback(ctx as unknown as { font: string }, GlobalFonts);
      await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp, canvas: c as unknown as HTMLCanvasElement }).promise;
      canvas = c as unknown as CanvasLike;
    }
    const pages = pdf.numPages;
    try { page.cleanup(); await pdf.cleanup(); await task.destroy(); } catch { /* 片付けの失敗は無視 */ }
    return { texts, pages, boxes, aspect: vp1.height / vp1.width, canvas, ms: Date.now() - started };
  } catch (e) {
    console.warn("[pdf-sheet-crop] 読めない:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** 画像（PNG/JPEG のバッファ）を canvas にする（PDF が無く、画像しか無い物件の時） */
export async function loadImageCanvas(image: Buffer): Promise<CanvasLike | null> {
  try {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(image);
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    return c as unknown as CanvasLike;
  } catch (e) {
    console.warn("[pdf-sheet-crop] 画像を読めない:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** 範囲（比率）を切り出して JPEG に。hash は切り出した画素（縮めた後）の sha256 先頭32文字 */
export async function cropCanvas(src: CanvasLike, rect: NormBox, opts?: { maxSide?: number; quality?: number; maxScale?: number }): Promise<{ jpeg: Buffer; width: number; height: number; hash: string } | null> {
  try {
    const { createCanvas } = await import("@napi-rs/canvas");
    const r = toPixelRect(rect, src.width, src.height);
    const k = Math.min(opts?.maxScale ?? 1, (opts?.maxSide ?? SHEET_CROP_MAX_SIDE) / Math.max(r.width, r.height));
    const w = Math.max(1, Math.round(r.width * k)), h = Math.max(1, Math.round(r.height * k));
    const c = createCanvas(w, h);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src as unknown as Parameters<typeof ctx.drawImage>[0], r.x, r.y, r.width, r.height, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const hash = createHash("sha256").update(Buffer.from(px.buffer, px.byteOffset, px.byteLength)).digest("hex").slice(0, 32);
    return { jpeg: c.toBuffer("image/jpeg", opts?.quality ?? 88), width: w, height: h, hash };
  } catch (e) {
    console.warn("[pdf-sheet-crop] 切り出せない:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** itandi の資料画像の左上の枠（黒い罫線）を画素で探す（sheet-layout.findItandiFrameBox）。見つからない・失敗は null */
export function findItandiFrameOnCanvas(src: CanvasLike): NormBox | null {
  try {
    const ctx = src.getContext("2d") as { getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> } };
    return findItandiFrameBox(ctx.getImageData(0, 0, src.width, src.height).data, src.width, src.height);
  } catch (e) {
    console.warn("[pdf-sheet-crop] 枠を探せない:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * 複数の範囲（比率）を上から順に縦に並べて1枚の JPEG に（itandi の画像: 上の帯→右の表）。
 * 並べた幅は一番広い範囲に合わせ、間に 8px の白を入れる。縮める倍率は全部で1つ（字の大きさを揃える）
 */
export async function cropCanvasStack(src: CanvasLike, rects: NormBox[], opts?: { maxSide?: number; quality?: number; maxScale?: number }): Promise<{ jpeg: Buffer; width: number; height: number; hash: string } | null> {
  try {
    const { createCanvas } = await import("@napi-rs/canvas");
    const rs = rects.map((r) => toPixelRect(r, src.width, src.height));
    const GAPPX = 8;
    const W0 = Math.max(...rs.map((r) => r.width)), H0 = rs.reduce((a, r) => a + r.height, 0) + GAPPX * (rs.length - 1);
    const k = Math.min(opts?.maxScale ?? 1, (opts?.maxSide ?? SHEET_CROP_MAX_SIDE) / Math.max(W0, H0));
    const w = Math.max(1, Math.round(W0 * k)), h = Math.max(1, Math.round(H0 * k));
    const c = createCanvas(w, h);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    let y = 0;
    for (const r of rs) {
      ctx.drawImage(src as unknown as Parameters<typeof ctx.drawImage>[0], r.x, r.y, r.width, r.height, 0, Math.round(y * k), Math.round(r.width * k), Math.round(r.height * k));
      y += r.height + GAPPX;
    }
    const px = ctx.getImageData(0, 0, w, h).data;
    const hash = createHash("sha256").update(Buffer.from(px.buffer, px.byteOffset, px.byteLength)).digest("hex").slice(0, 32);
    return { jpeg: c.toBuffer("image/jpeg", opts?.quality ?? 88), width: w, height: h, hash };
  } catch (e) {
    console.warn("[pdf-sheet-crop] 並べて切り出せない:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
