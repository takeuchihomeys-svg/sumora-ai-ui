// app/lib/pdf-image-boxes.ts（純関数・何も import しない・画面とサーバーで共用）
// pdfjs の描画命令の並び（getOperatorList）から、ページに描いた画像の位置（ページ比）を求める。
// 2026-10-06: pdf-sheet-crop.ts（サーバー専用・node:crypto）から移した。ITANDI の募集図面の帯替え（zumen-obi）を画面（ブラウザ）でも使うため。
//   pdf-sheet-crop.ts は同じ関数をここから re-export している（中身は変えていない）
import type { NormBox } from "./sheet-layout";

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
