// app/lib/pdf-text.ts
// PDF の「文字層」を取り出す（純 JS・ネイティブ依存なし・Node 専用）。
//
// 2026-09-24 竹内「PDF は DeepSeek が読めるようになっているのか」:
//   DeepSeek は画像（JPEG/PNG/GIF/WebP）しか受けず、PDF は自分で変換してから渡す必要がある（公式仕様）。
//   リアプロの印刷用 PDF は作られた PDF（スキャンではない）なので、まず**文字層**を取り出して文字として渡す。
//   画像にする道（ラスタライズ）はネイティブの canvas が要り Vercel での動作リスクが高いので、文字層が無い時の次の手にする。
//   設計知見: 読み取りの材料にするのは「有無・可否」だけ。金額・徒歩・㎡の数値は「表の文字（bulk-dl の説明文）」が正。
// 2026-09-24 竹内「文字が反映されていないバグ」: cMapUrl を渡していなかったので、埋め込みなしの日本語フォント（MS ゴシック・Identity-H）の
//   PDF から文字が1文字も取れず（本番 withText:0）、順位付け・画像の読み取りが文字層なしで動いていた → pdfjs-assets.ts で CMap も渡す
//   （旧 require.resolve は本番の Turbopack で数値に置き換わり、標準フォントの置き場も渡っていなかった）
import { pdfjsAssetParams } from "./pdfjs-assets";

export type PdfTextResult = {
  text: string;
  pages: number;
  /** 文字層があったか（文字数が少なければ false＝スキャン画像の可能性） */
  hasText: boolean;
  ms: number;
};

const MIN_TEXT_CHARS = 40;

/** base64 か bytes から、先頭 maxPages ページの文字を取り出す。失敗は text="" で返す（投げない） */
export async function extractPdfText(input: string | Uint8Array, opts?: { maxPages?: number; maxChars?: number }): Promise<PdfTextResult> {
  const started = Date.now();
  const maxPages = opts?.maxPages ?? 2;
  const maxChars = opts?.maxChars ?? 6000;
  try {
    const bytes = typeof input === "string" ? Uint8Array.from(Buffer.from(input, "base64")) : input;
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // CMap（日本語の文字コード対応表・無いと文字が取れない）と標準フォントの置き場
    const task = pdfjs.getDocument({ data: bytes, disableWorker: true, isEvalSupported: false, useSystemFonts: false, ...pdfjsAssetParams() } as Parameters<typeof pdfjs.getDocument>[0]);
    const pdf = await task.promise;
    const parts: string[] = [];
    const n = Math.min(pdf.numPages, maxPages);
    for (let p = 1; p <= n; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      // 行の区切りは Y 座標の変化で入れる（表の文字が1行に潰れないように）
      let lastY: number | null = null;
      const line: string[] = [];
      for (const it of tc.items as Array<{ str?: string; transform?: number[] }>) {
        if (typeof it.str !== "string") continue;
        const y = Array.isArray(it.transform) ? Math.round(it.transform[5]) : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) { parts.push(line.join(" ")); line.length = 0; }
        if (it.str.trim()) line.push(it.str.trim());
        if (y !== null) lastY = y;
      }
      if (line.length) parts.push(line.join(" "));
      if (parts.join("\n").length >= maxChars) break;
    }
    const text = parts.join("\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim().slice(0, maxChars);
    try { await pdf.cleanup(); await task.destroy(); } catch { /* 片付けの失敗は無視 */ }
    return { text, pages: pdf.numPages, hasText: text.length >= MIN_TEXT_CHARS, ms: Date.now() - started };
  } catch (e) {
    console.warn("[pdf-text] 取り出せない:", e instanceof Error ? e.message : String(e));
    return { text: "", pages: 0, hasText: false, ms: Date.now() - started };
  }
}
