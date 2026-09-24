// PDF の1ページ目で使われているフォントが埋め込みか（本番 Linux で文字が抜ける原因の切り分け・読み取りのみ）
// 実行: npx tsx --env-file=.env.local scripts/peek-pdf-fonts.ts [--limit=1]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const limit = Number(arg("limit") ?? "1");
async function main() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { data } = await sb.from("property_pickups").select("id, pdf_blob_url").not("pdf_blob_url", "is", null).order("created_at", { ascending: false }).limit(limit);
  for (const r of (data ?? []) as Array<{ id: number; pdf_blob_url: string }>) {
    const buf = new Uint8Array(await (await fetch(r.pdf_blob_url)).arrayBuffer());
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const base = req.resolve("pdfjs-dist/package.json").replace(/package\.json$/, "");
    const task = pdfjs.getDocument({ data: buf, disableWorker: true, isEvalSupported: false, useSystemFonts: false, cMapUrl: base + "cmaps/", cMapPacked: true, standardFontDataUrl: base + "standard_fonts/" } as Parameters<typeof pdfjs.getDocument>[0]);
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    await page.getOperatorList();
    const fonts: string[] = [];
    (page.commonObjs as unknown as { _objs: Record<string, { data?: { name?: string; loadedName?: string; missingFile?: boolean; isType3Font?: boolean; fallbackName?: string; data?: unknown; mimetype?: string } }> })._objs &&
      Object.entries((page.commonObjs as unknown as { _objs: Record<string, { data?: Record<string, unknown> }> })._objs).forEach(([k, v]) => {
        const f = v?.data as Record<string, unknown> | undefined;
        if (!f || !String(k).startsWith("g_")) return;
        fonts.push(`${f.name ?? "?"} loaded=${f.loadedName ?? "?"} missingFile=${f.missingFile ?? "?"} hasData=${!!f.data} fallback=${f.fallbackName ?? "?"} mime=${f.mimetype ?? "?"}`);
      });
    console.log(`id=${r.id} フォント ${fonts.length}件`);
    for (const f of fonts) console.log("  " + f);
    const tc = await page.getTextContent();
    const fams = new Set<string>();
    for (const s of Object.values(tc.styles)) fams.add(`${s.fontFamily}`);
    console.log("  textContent の fontFamily:", [...fams].join(", "));
    await pdf.cleanup(); await task.destroy();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
