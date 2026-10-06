// scripts/make-obi-hasu.ts
// 弊社の帯の画像（public/brand/obi-hasu.png）を、リアプロの帯替え済みの資料（1ページ目＝弊社帯）から切り出して作る。
// 2026-10-06 竹内「帯替えとはこのように弊社の情報に帯を変更するということ」「弊社の情報は既存の定義から取り、ハードコードで新しく増やさない」
//   → 会社名・免許番号・住所・TEL を文字で書き起こさず、リアプロが作った弊社の帯（スタッフのパソコンの Chrome で MS ゴシックのまま描いた
//     trim_image_url）をそのまま切り出す。帯の上下は同じ資料の PDF の文字層（免許番号の行〜TEL の行）で決める（座標の決め打ちなし）。
//   会社の情報（移転・免許の更新回数）が変わったら、リアプロの帯が変わった後にこれを回し直す。
//
// 実行: npx tsx --env-file=.env.local scripts/make-obi-hasu.ts [--id=<property_pickups の id>] [--out=public/brand/obi-hasu.png]
//   読むだけ（DB・Blob）。書くのは手元の画像1枚だけ
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pdfjsAssetParams } from "../app/lib/pdfjs-assets";
import { linesFromItems, LICENSE_RE } from "../app/lib/zumen-obi";
import { textItemBox } from "../app/lib/zumen-obi-pdf";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const OUT = arg("out", "public/brand/obi-hasu.png");

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
  let q = sb.from("property_pickups").select("id, site, trim_image_url, pdf_blob_url").eq("site", "realpro").not("trim_image_url", "is", null).not("pdf_blob_url", "is", null);
  const id = Number(arg("id"));
  q = id > 0 ? q.eq("id", id) : q.order("id", { ascending: false }).limit(1);
  const { data, error } = await q;
  if (error || !data?.length) throw new Error(`リアプロの行が取れない: ${error?.message ?? "0件"}`);
  const row = data[0] as { id: number; trim_image_url: string; pdf_blob_url: string };
  console.log(`元: property_pickups #${row.id}`);

  const pdfBytes = new Uint8Array(await (await fetch(row.pdf_blob_url)).arrayBuffer());
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: pdfBytes, disableWorker: true, isEvalSupported: false, useSystemFonts: false, ...pdfjsAssetParams() } as Parameters<typeof pdfjs.getDocument>[0]);
  const pdf = await task.promise;
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = (tc.items as Array<{ str?: string; transform?: number[]; width?: number }>)
    .map((it) => textItemBox(pdfjs.Util as never, vp.transform, vp.width, vp.height, 1, it)).filter((x): x is NonNullable<typeof x> => !!x);
  const lines = linesFromItems(items);
  const lic = lines.find((l) => l.y0 > 0.7 && LICENSE_RE.test(l.text));
  if (!lic) throw new Error("1ページ目の下に免許番号の行が無い（帯替え済みの面ではない）");
  // 帯の行＝免許番号の行から下で、「出力日」「Powered by」（リアプロの印字）より上
  const band = lines.filter((l) => l.y0 >= lic.y0 - 0.002 && !/出力日|Powered\s*by|RealNetPro/i.test(l.text));
  const tel = band.filter((l) => /TEL/.test(l.text)).pop();
  if (!tel) throw new Error("帯に TEL の行が無い");
  const rows = band.filter((l) => l.y1 <= tel.y1 + 0.002);
  console.log("帯の行:\n  " + rows.map((l) => l.text).join("\n  "));
  // 1ページ目が帯替え済み（弊社）である事を確かめる（偶数ページ＝元付と取り違えない）。会社名は文字層から読むだけで書き起こさない
  if (!rows.some((l) => /蓮産業/.test(l.text))) throw new Error("帯に弊社の名前が無い（偶数ページ＝元付の面を取った可能性）");
  const y0 = Math.max(0, lic.y0 - 0.008), y1 = Math.min(1, tel.y1 + 0.008);
  const x0 = Math.max(0, Math.min(...rows.map((l) => l.x0)) - 0.006), x1 = Math.min(1, Math.max(...rows.map((l) => l.x1)) + 0.006);
  await task.destroy();

  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(Buffer.from(await (await fetch(row.trim_image_url)).arrayBuffer()));
  const sx = Math.floor(x0 * img.width);
  let sy = Math.floor(y0 * img.height);
  const sw = Math.ceil((x1 - x0) * img.width);
  // リアプロの枠のオレンジの線（帯の上の罫線）は入れない: 上の方で色の付いた画素が横に 30% 以上ある行の下から切る
  {
    const probeH = Math.ceil((y1 - y0) * img.height * 0.4);
    const pc = createCanvas(sw, probeH);
    const pctx = pc.getContext("2d");
    pctx.drawImage(img, sx, sy, sw, probeH, 0, 0, sw, probeH);
    const px = pctx.getImageData(0, 0, sw, probeH).data;
    let last = -1;
    for (let y = 0; y < probeH; y++) {
      let n = 0;
      for (let x = 0; x < sw; x++) { const i = (y * sw + x) * 4; if (Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) > 60) n++; }
      if (n / sw >= 0.3) last = y;
    }
    if (last >= 0) sy += last + 2;
  }
  const sh = Math.ceil(y1 * img.height) - sy;
  const c = createCanvas(sw, sh);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  const outPath = join(process.cwd(), OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, c.toBuffer("image/png"));
  console.log(`書いた: ${OUT}（${sw}×${sh}px・元の画像 ${img.width}×${img.height}・範囲 x ${x0.toFixed(3)}〜${x1.toFixed(3)} y ${y0.toFixed(3)}〜${y1.toFixed(3)}）`);
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
