// scripts/audit-zumen-obi.ts
// ITANDI の「まとめて図面取得」の ZIP（Downloads の ITANDI_BB_募集図面*.zip）に、帯替えの判断（zumen-obi.planObiReplace）を全部当てる監査。
// 2026-10-06 竹内「帯の部分だけ判断して変えれば良い」— 誤って本文を切らない（誤り0）かを目で確かめるための道具。
//   読むだけ（手元の ZIP）。出力は --out のフォルダに: 帯替えした画像（*_obi.jpg）・切れ目に赤い線を引いた元の画像（*_cut.jpg）・止めた物（*_stop.jpg）
//   LLM は使わない。お客様の情報は入っていない（元付業者が作った募集図面だけ）
//
// 実行: npx tsx scripts/audit-zumen-obi.ts --dir="C:/Users/<you>/Downloads" --out=<出力フォルダ> [--match=20261006] [--limit=20]
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { pdfjsAssetParams } from "../app/lib/pdfjs-assets";
import { installJapaneseFontFallback } from "../app/lib/pdf-render";
import { groupZumenFiles, planObiReplace, paintObi, type ObiPlan } from "../app/lib/zumen-obi";
import { extractObiFeatures, type CanvasPair } from "../app/lib/zumen-obi-pdf";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DIR = arg("dir"), OUT = arg("out"), MATCH = arg("match"), LIMIT = Number(arg("limit", "999"));

(async () => {
  if (!DIR || !OUT) throw new Error("--dir と --out が要る");
  mkdirSync(OUT, { recursive: true });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas, loadImage, GlobalFonts } = await import("@napi-rs/canvas");
  const bandImg = await loadImage(readFileSync(join(process.cwd(), "public/brand/obi-hasu.png")));
  const zips = readdirSync(DIR).filter((f) => /^ITANDI_BB_募集図面.*\.zip$/i.test(f) && (!MATCH || f.includes(MATCH))).sort().reverse().slice(0, LIMIT);
  const tally: Record<string, number> = {};
  const rows: string[] = [];
  let n = 0;
  for (const z of zips) {
    const zip = await JSZip.loadAsync(readFileSync(join(DIR, z)));
    const entries = Object.values(zip.files).filter((f) => !f.dir).map((f) => ({ path: f.name, file: f }));
    const groups = groupZumenFiles(entries);
    for (const g of groups) {
      for (const e of g.files) {
        n++;
        const tag = `${z.replace(/\D/g, "").slice(0, 14)}_${e.path.split("/").pop()!.replace(/\.[^.]+$/, "")}`.replace(/[\\/:*?"<>|]/g, "_");
        let plan: ObiPlan;
        if (!/\.pdf$/i.test(e.path)) {
          plan = { kind: "stop", code: "image_only", reason: "画像の図面（文字の層が無い）＝帯の有無を確かめられない", warnings: [] };
          const img = await loadImage(Buffer.from(await e.file.async("uint8array")));
          const c = createCanvas(Math.min(900, img.width), Math.round(Math.min(900, img.width) * img.height / img.width));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          writeFileSync(join(OUT, `${tag}_stop.jpg`), c.toBuffer("image/jpeg", 70));
        } else {
          const task = pdfjs.getDocument({ data: await e.file.async("uint8array"), disableWorker: true, isEvalSupported: false, useSystemFonts: false, ...pdfjsAssetParams() } as Parameters<typeof pdfjs.getDocument>[0]);
          const pdf = await task.promise;
          const page = await pdf.getPage(1);
          const f = await extractObiFeatures(pdfjs as never, page as never, (w, h) => {
            const canvas = createCanvas(w, h);
            return { canvas, ctx: canvas.getContext("2d") } as unknown as CanvasPair;
          }, { scale: 1.6, beforeRender: (ctx) => installJapaneseFontFallback(ctx as { font: string }, GlobalFonts) });
          plan = planObiReplace({ rotate: f.rotate, items: f.items, images: f.images, rows: f.rows });
          const canvas = f.pair.canvas as unknown as { toBuffer(m: string, q?: number): Buffer; getContext(k: string): { fillStyle: unknown; fillRect(x: number, y: number, w: number, h: number): void } };
          if (plan.kind === "replace") {
            // 切れ目に赤い線を引いた元（目で見る用）
            const cut = createCanvas(f.width, f.height);
            const cctx = cut.getContext("2d");
            cctx.drawImage(f.pair.canvas as never, 0, 0);
            cctx.fillStyle = "rgba(255,0,0,0.9)"; cctx.fillRect(0, Math.floor(plan.cutY * f.height) - 1, f.width, 3);
            cctx.fillStyle = "rgba(255,0,0,0.12)"; cctx.fillRect(0, Math.floor(plan.cutY * f.height), f.width, f.height);
            writeFileSync(join(OUT, `${tag}_cut.jpg`), cut.toBuffer("image/jpeg", 70));
            paintObi(f.pair.ctx as never, f.width, f.height, plan.cutY, { width: bandImg.width, height: bandImg.height, image: bandImg });
            writeFileSync(join(OUT, `${tag}_obi.jpg`), canvas.toBuffer("image/jpeg", 80));
          } else {
            writeFileSync(join(OUT, `${tag}_stop.jpg`), canvas.toBuffer("image/jpeg", 60));
          }
          await task.destroy();
        }
        const key = plan.kind === "replace" ? "replace" : `stop:${plan.code}`;
        tally[key] = (tally[key] ?? 0) + 1;
        rows.push(`${plan.kind === "replace" ? "✂" : "⏸"} ${tag}  ${plan.kind === "replace" ? `cut=${plan.cutY.toFixed(3)} [${plan.zoneMarkers.join("・")}]` : plan.reason}${plan.warnings.length ? `  ⚠${plan.warnings.join("／")}` : ""}`);
      }
    }
  }
  writeFileSync(join(OUT, "_result.txt"), rows.join("\n"));
  console.log(rows.join("\n"));
  console.log(`\nZIP ${zips.length}・ファイル ${n}`, tally);
})().catch((e) => { console.error(e); process.exit(1); });
