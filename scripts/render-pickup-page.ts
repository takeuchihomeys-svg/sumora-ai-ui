// property_pickups の PDF（Blob）を落として指定ページを PNG にする（読み取りのみ・出力は scratchpad へ）
// 実行: npx tsx --env-file=.env.local scripts/render-pickup-page.ts --out=<dir> [--page=1] [--limit=3]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderPdfPageToPng } from "../app/lib/pdf-render";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const out = arg("out") ?? ".";
const page = Number(arg("page") ?? "1");
const limit = Number(arg("limit") ?? "3");
async function main() {
  mkdirSync(out, { recursive: true });
  const { data } = await sb.from("property_pickups").select("id, property_name, pdf_blob_url").not("pdf_blob_url", "is", null).order("created_at", { ascending: false }).limit(limit);
  for (const r of (data ?? []) as Array<{ id: number; property_name: string; pdf_blob_url: string }>) {
    const res = await fetch(r.pdf_blob_url);
    const buf = Buffer.from(await res.arrayBuffer());
    const png = await renderPdfPageToPng(buf.toString("base64"), { page, scale: 1.5 });
    if (!png) { console.log(`id=${r.id} ページ ${page} を画像にできない`); continue; }
    const file = join(out, `pickup_${r.id}_p${page}.png`);
    writeFileSync(file, png.png);
    console.log(`id=${r.id} ${r.property_name.slice(0, 12)} ${png.width}x${png.height} → ${file}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
