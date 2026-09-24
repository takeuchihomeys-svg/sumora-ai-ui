// 2026-09-24 竹内「文字が反映されていないバグも起きている。原因見つけて改善する」— 再発を捕まえるテスト
// 実行: npx tsx app/lib/__tests__/pdf-render-text.test.ts
//
// 原因: 本番（Turbopack）で require.resolve が数値に置き換わり、pdfjs に cMapUrl が渡らず、埋め込みなしの日本語フォントの文字が
//   描画命令ごと捨てられていた（画像は落ちずに「白い表」になるだけ）。tsx では require.resolve が通るので、
//   ①ソースに require.resolve を戻していないか（静的な見張り） ②実物の資料で文字が「描かれて」「画像に色が乗る」か の両方で見る。
// 実物: fixtures/realpro-sheet-2p.pdf（リアプロの印刷用 PDF・1ページ目＝帯替え／2ページ目＝元付。物件資料のみ・お客様の情報は無い）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPdfPageToPng, fontWeightOf, rewriteFontFamily } from "../pdf-render";
import { extractPdfText } from "../pdf-text";
import { pdfjsAssetDir, pdfjsAssetParams } from "../pdfjs-assets";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ""}`); }
}

/** コメントを外したコード部分（説明のコメントに require.resolve と書いてあるのは許す） */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1")).join("\n");
}

async function main() {
  // ① 静的な見張り: pdfjs の置き場を require.resolve で求めない（Turbopack が数値に置き換える）
  for (const f of ["pdf-render.ts", "pdf-text.ts", "pdfjs-assets.ts"]) {
    const src = codeOnly(readFileSync(join(__dirname, "..", f), "utf8"));
    t(`★ ${f} のコードに require.resolve が無い（本番で数値に置き換わり cMapUrl が消えた）`, !/require\.resolve\s*\(/.test(src));
    t(`★ ${f} に createRequire が無い`, !/createRequire/.test(src));
  }
  // pdf-text も pdf-render も cMap を渡す（片方だけ直して文字層が空のまま、を防ぐ）
  for (const f of ["pdf-render.ts", "pdf-text.ts"]) {
    const src = codeOnly(readFileSync(join(__dirname, "..", f), "utf8"));
    t(`★ ${f} は pdfjsAssetParams を getDocument に渡す`, /\.\.\.pdfjsAssetParams\(\)/.test(src));
  }

  // ② 置き場が見つかる
  const cm = pdfjsAssetDir("cmaps");
  const sf = pdfjsAssetDir("standard_fonts");
  t("★ cmaps の置き場が見つかる（末尾 /）", !!cm && cm.endsWith("/"), cm);
  t("★ standard_fonts の置き場が見つかる（末尾 /）", !!sf && sf.endsWith("/"), sf);
  const p = pdfjsAssetParams();
  t("★ getDocument の引数に cMapUrl・cMapPacked・standardFontDataUrl が揃う", typeof p.cMapUrl === "string" && p.cMapPacked === true && typeof p.standardFontDataUrl === "string", p);

  // ③ 実物の資料: 文字層が取れる
  const pdf = new Uint8Array(readFileSync(join(__dirname, "fixtures", "realpro-sheet-2p.pdf")));
  const text = await extractPdfText(pdf.slice(), { maxPages: 2, maxChars: 8000 });
  t("★ 文字層が取れる（本番は cMap なしで hasText:false だった）", text.hasText && text.pages === 2, { len: text.text.length, pages: text.pages });
  t("★ 表の文字（物件名・賃料・設備）が文字層に入っている", /スプランディッド難波WEST/.test(text.text) && /77,000/.test(text.text) && /バス・トイレ別/.test(text.text));

  // ④ 実物の資料: 1ページ目を描くと文字が描かれ、表の欄に色が乗る
  const r1 = await renderPdfPageToPng(pdf.slice(), { page: 1, scale: 1.5 });
  t("★ 1ページ目を画像にできる", !!r1 && r1.width > 1000 && r1.height > 700, r1 && { w: r1.width, h: r1.height });
  t("★ 文字を描いた数が十分（本番の文字抜けは 0 回・直した後は 768 回）", !!r1 && r1.textDraws >= 300, r1?.textDraws);
  if (r1) {
    const { loadImage, createCanvas } = await import("@napi-rs/canvas");
    const img = await loadImage(r1.png);
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    // 物件名の値の欄（左の表・2行目の右側）。1548×1093 の座標を比率で持つ（大きさが変わっても同じ所）
    const ink = (fx: number, fy: number, fw: number, fh: number) => {
      const x = Math.round(img.width * fx), y = Math.round(img.height * fy), w = Math.round(img.width * fw), h = Math.round(img.height * fh);
      const d = ctx.getImageData(x, y, w, h).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 3 * 160) dark++;
      return dark / (w * h);
    };
    const nameInk = ink(0.105, 0.058, 0.215, 0.022);   // 「スプランディッド難波WEST」
    const rentInk = ink(0.105, 0.312, 0.1, 0.03);      // 「77,000 円」
    const equipInk = ink(0.02, 0.6, 0.3, 0.06);        // 設備欄（【キッチン】…）
    t("★ 物件名の欄に文字の色が乗る（白いままなら文字抜け）", nameInk > 0.03, nameInk);
    t("★ 賃料の欄に文字の色が乗る", rentInk > 0.03, rentInk);
    t("★ 設備欄に文字の色が乗る（画像で分析の材料）", equipInk > 0.02, equipInk);
  }
  const r2 = await renderPdfPageToPng(pdf.slice(), { page: 2, scale: 1.5 });
  t("★ 2ページ目（元付）も文字が描かれる", !!r2 && r2.textDraws >= 300, r2?.textDraws);
  t("★ 無いページ（3）は null（丸めない）", (await renderPdfPageToPng(pdf.slice(), { page: 3 })) === null);

  // ⑤ 太さ（可変フォントの wght 軸に写す）
  t("★ bold → 700", fontWeightOf('normal bold 12px "g_d0_f1", serif') === 700);
  t("★ 数字の太さ 600", fontWeightOf('600 10.5px "g_d0_f1"') === 600);
  t("★ 指定なし → 400", fontWeightOf('normal normal 12px "g_d0_f1", serif') === 400);
  t("★ 家族名の数字（g_d0_f1）を太さと取り違えない", fontWeightOf('12px "g_d0_f700"') === 400);
  t("★ rewriteFontFamily は太さの部分を残す", rewriteFontFamily('bold 12px "g_d0_f1", serif') === 'bold 12px "Noto Sans JP", sans-serif');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void main();
