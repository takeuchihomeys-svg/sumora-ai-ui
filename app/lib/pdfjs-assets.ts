// app/lib/pdfjs-assets.ts（サーバー専用・Node の fs を使う。画面側から import しない）
// pdfjs-dist の CMap（cmaps/）と標準フォント（standard_fonts/）の置き場を求める。pdf-render.ts と pdf-text.ts が共用する。
//
// 2026-09-24 竹内「文字が反映されていないバグも起きている。原因見つけて改善する」:
//   本番の売上サポの画像（page_image_url）で表・説明欄の文字が全部抜けていた。原因は日本語フォントではなく
//   **pdfjs に cMapUrl が一度も渡っていなかった**こと（本番ログ: `Ensure that the cMapUrl API parameter is provided.`・withText:0）。
//   旧コードは `require.resolve("pdfjs-dist/package.json").replace(...)` で置き場を求めていたが、
//   Turbopack（本番ビルド）はこの require.resolve を**モジュール番号（数値）に置き換える**ので `.replace` が TypeError →
//   catch で黙って undefined → cMap なしで getDocument。埋め込みなしの CID フォント（MS ゴシック・Identity-H）が読めず、
//   その文字の描画命令ごと捨てられていた（fillText 0 回）。tsx（テスト・ローカルのスクリプト）では実際のパスが返るので気付けない。
//   → require.resolve を使わず `process.cwd()/node_modules/pdfjs-dist/<sub>/` を existsSync で確かめる
//     （next.config.ts の outputFileTracingIncludes が /var/task/node_modules/pdfjs-dist/cmaps/ に同梱している）。
//   → 見つからない時は必ず console.warn（黙って undefined にしない＝静かに壊れない）
import { existsSync } from "node:fs";
import { join } from "node:path";

export type PdfjsAssetKind = "cmaps" | "standard_fonts";

/** 目印のファイル（中身がある事まで確かめる。空のディレクトリだけ同梱された時も「無い」と言う） */
const PROBE: Record<PdfjsAssetKind, string> = {
  cmaps: "Adobe-Japan1-UCS2.bcmap",   // 日本語の文字コード対応表（文字層の取り出しにも要る）
  standard_fonts: "FoxitSerif.pfb",
};

const cache = new Map<PdfjsAssetKind, string | null>();

/** 候補の場所（テスト用に export）。先頭から順に見る */
export function pdfjsAssetCandidates(sub: PdfjsAssetKind, cwd: string = process.cwd()): string[] {
  return [
    join(cwd, "node_modules", "pdfjs-dist", sub),
    // Vercel の関数は /var/task が cwd。念のため絶対パスでも見る
    join("/var/task", "node_modules", "pdfjs-dist", sub),
  ];
}

/**
 * pdfjs の置き場（末尾に "/" 付き・pdfjs は Node では fs.readFile(url + 名前) で読む）。無ければ undefined と警告。
 * ⚠ require.resolve を使わない（Turbopack が数値に置き換える・上の説明）
 */
export function pdfjsAssetDir(sub: PdfjsAssetKind): string | undefined {
  if (cache.has(sub)) return cache.get(sub) ?? undefined;
  let found: string | null = null;
  for (const dir of pdfjsAssetCandidates(sub)) {
    try {
      if (existsSync(join(dir, PROBE[sub]))) { found = dir.replace(/[\\/]+$/, "") + "/"; break; }
    } catch { /* 次の候補 */ }
  }
  if (!found) {
    console.warn(`[pdfjs-assets] ${sub} が無い（${pdfjsAssetCandidates(sub).join(" / ")}）→ 埋め込みなしの日本語の文字が抜ける。next.config.ts の outputFileTracingIncludes を確かめる`);
  }
  cache.set(sub, found);
  return found ?? undefined;
}

/** getDocument に足す引数（cMapUrl・cMapPacked・standardFontDataUrl）。見つからない物は付けない */
export function pdfjsAssetParams(): { cMapUrl?: string; cMapPacked?: boolean; standardFontDataUrl?: string } {
  const cMapUrl = pdfjsAssetDir("cmaps");
  const standardFontDataUrl = pdfjsAssetDir("standard_fonts");
  return {
    ...(cMapUrl ? { cMapUrl, cMapPacked: true } : {}),
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
  };
}
