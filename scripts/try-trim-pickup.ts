// ローカルでトリミングの形を確かめる（読み取りのみ・出力は指定 dir）。API は呼ばない
// 実行: npx tsx --env-file=.env.local scripts/try-trim-pickup.ts --out=<dir> [--limit=2]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderPdfPageToPng } from "../app/lib/pdf-render";
import { trimSheetImage, cropRectForSheet } from "../app/lib/pdf-trim";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const out = arg("out") ?? ".";
const limit = Number(arg("limit") ?? "2");
async function main() {
  mkdirSync(out, { recursive: true });
  console.log("矩形の例 1548x1093 →", JSON.stringify(cropRectForSheet(1548, 1093)));
  const { data } = await sb.from("property_pickups").select("id, property_name, pdf_blob_url").not("pdf_blob_url", "is", null).order("created_at", { ascending: false }).limit(limit);
  for (const r of (data ?? []) as Array<{ id: number; property_name: string; pdf_blob_url: string }>) {
    const buf = Buffer.from(await (await fetch(r.pdf_blob_url)).arrayBuffer());
    const png = await renderPdfPageToPng(buf.toString("base64"), { page: 1, scale: 2, maxPixels: 4_000_000 });
    if (!png) { console.log(`id=${r.id} 画像にできない`); continue; }
    const t = await trimSheetImage(png.png);
    if (!t) { console.log(`id=${r.id} トリミングできない`); continue; }
    const file = join(out, `trim_${r.id}.jpg`);
    writeFileSync(file, t.jpeg);
    console.log(`id=${r.id} ${r.property_name.slice(0, 12)} ${png.width}x${png.height} → ${t.width}x${t.height} ${Math.round(t.jpeg.length / 1024)}KB ${file}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
