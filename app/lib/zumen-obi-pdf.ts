// app/lib/zumen-obi-pdf.ts（pdfjs と canvas を引数で受ける・何も環境の物を import しない＝画面とサーバーの監査で共用）
// 募集図面（PDF）の1ページを描き、帯の判断（zumen-obi.planObiReplace）の材料＝文字の片・画像の位置・行ごとの画素を取る。
// 2026-10-06 竹内「帯の部分だけ判断して変えれば良い」
//   画面（スタッフのパソコンのブラウザ）は pdfjs-dist ＋ document の canvas、監査のスクリプト（Node）は pdfjs-dist/legacy ＋ @napi-rs/canvas を渡す。
//   ⚠ ここに pdfjs・@napi-rs/canvas・node: を import しない（画面のビルドにサーバーの物が入ると本番のビルドが落ちる）
import { imageBoxesFromOps } from "./pdf-image-boxes";
import { rowProfileFromPixels, type ObiBox, type ObiRowProfile, type ObiTextItem } from "./zumen-obi";

/** 使う pdfjs の部分（ブラウザ版・legacy 版のどちらも満たす） */
export type PdfjsLike = {
  OPS: Record<string, number>;
  Util: { transform(a: number[], b: number[]): number[] };
};
export type PdfPageLike = {
  rotate: number;
  getViewport(o: { scale: number }): { width: number; height: number; transform: number[]; convertToViewportPoint(x: number, y: number): number[] };
  getTextContent(o?: unknown): Promise<{ items: unknown[]; styles?: Record<string, unknown> }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  render(o: { canvasContext: unknown; viewport: unknown; canvas?: unknown }): { promise: Promise<unknown> };
};
export type CanvasPair = {
  canvas: { width: number; height: number };
  ctx: {
    fillStyle: unknown;
    fillRect(x: number, y: number, w: number, h: number): void;
    getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
    drawImage(img: unknown, dx: number, dy: number, dw: number, dh: number): void;
  };
};

export type ObiPageFeatures = {
  rotate: number;
  items: ObiTextItem[];
  images: ObiBox[];
  rows: ObiRowProfile;
  /** 描いたページ（帯替えはこの上に描く） */
  pair: CanvasPair;
  width: number;
  height: number;
  /** pdfjs の textContent.styles（書体の差し替えの判定に使う） */
  styles: Record<string, unknown>;
  textChars: number;
};

/** pdfjs の文字の片の位置（ページ比）。横書き・縦書き・回転を変換行列のまま扱う（四隅の外接の箱） */
export function textItemBox(Util: PdfjsLike["Util"], vpTransform: number[], vpW: number, vpH: number, scale: number, it: { str?: string; transform?: number[]; width?: number }): ObiTextItem | null {
  if (!it || typeof it.str !== "string" || !Array.isArray(it.transform)) return null;
  const tx = Util.transform(vpTransform, it.transform);
  const fontH = Math.hypot(tx[2], tx[3]);
  if (!(fontH > 0)) return null;
  const dl = Math.hypot(tx[0], tx[1]) || 1;
  const L = Math.max(0, (it.width ?? 0) * scale);
  const d = [(tx[0] / dl) * L, (tx[1] / dl) * L];
  const u = [tx[2], tx[3]];
  // u は「上」の向き（画面の y は下向きなので横書きでは負）。下に字の降りる分（0.2）を足す
  const o = [tx[4], tx[5]];
  const pts = [o, [o[0] + d[0], o[1] + d[1]], [o[0] + u[0], o[1] + u[1]], [o[0] + d[0] + u[0], o[1] + d[1] + u[1]],
    [o[0] - u[0] * 0.2, o[1] - u[1] * 0.2], [o[0] + d[0] - u[0] * 0.2, o[1] + d[1] - u[1] * 0.2]];
  const xs = pts.map((p) => p[0] / vpW), ys = pts.map((p) => p[1] / vpH);
  return { s: it.str, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/**
 * ページを描き、帯の判断の材料を取る。
 * @param makeCanvas 幅・高さから canvas と 2D を作る（ブラウザ: document.createElement／Node: @napi-rs/canvas）
 * @param beforeRender 描く前に ctx を整える（Node の監査で日本語の書体を当てる等）
 */
export async function extractObiFeatures(
  pdfjs: PdfjsLike, page: PdfPageLike,
  makeCanvas: (w: number, h: number) => CanvasPair,
  opts?: { scale?: number; beforeRender?: (ctx: unknown) => void },
): Promise<ObiPageFeatures> {
  const scale = opts?.scale ?? 2;
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale });
  const W = Math.ceil(vp.width), H = Math.ceil(vp.height);
  const pair = makeCanvas(W, H);
  pair.ctx.fillStyle = "#ffffff";
  pair.ctx.fillRect(0, 0, W, H);
  opts?.beforeRender?.(pair.ctx);
  await page.render({ canvasContext: pair.ctx, viewport: vp, canvas: pair.canvas }).promise;
  const tc = await page.getTextContent({ includeMarkedContent: false });
  const items: ObiTextItem[] = [];
  let textChars = 0;
  for (const raw of tc.items as Array<{ str?: string; transform?: number[]; width?: number }>) {
    const b = textItemBox(pdfjs.Util, vp.transform, vp.width, vp.height, scale, raw);
    if (!b || !b.s.trim()) continue;
    textChars += b.s.trim().length;
    items.push(b);
  }
  const ol = await page.getOperatorList();
  const images = imageBoxesFromOps(ol, pdfjs.OPS, (x, y) => vp1.convertToViewportPoint(x, y) as [number, number], { width: vp1.width, height: vp1.height });
  const rows = rowProfileFromPixels(pair.ctx.getImageData(0, 0, W, H).data, W, H);
  return { rotate: page.rotate ?? 0, items, images, rows, pair, width: W, height: H, styles: (tc.styles ?? {}) as Record<string, unknown>, textChars };
}
