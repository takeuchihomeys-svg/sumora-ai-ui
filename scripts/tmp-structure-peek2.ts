import { createClient } from "@supabase/supabase-js";
import { extractPdfText } from "../app/lib/pdf-text";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const { data: pk } = await sb.from("property_pickups").select("id, site, pdf_text, pdf_blob_url").order("id");
  for (const r of pk!) {
    let t = String(r.pdf_text ?? "");
    if (!t && r.pdf_blob_url) { try { const res = await fetch(r.pdf_blob_url); if (res.ok) { const b = Buffer.from(await res.arrayBuffer()).toString("base64"); t = (await extractPdfText(b, { maxPages: 2, maxChars: 8000 })).text ?? ""; } else t = `(HTTP ${res.status})`; } catch (e) { t = "(err)"; } }
    t = t.normalize("NFKC");
    const lines = t.split("\n");
    const pick = lines.map((l, i) => [l, lines[i + 1] ?? ""]).filter(([l]) => /構造|種別|種目|住居用|エレベ|EV/.test(l)).map(([l, n2]) => `${l.trim()} ⏎ ${n2.trim()}`.slice(0, 100));
    if (r.site === "realpro") console.log(`#${r.id} len${t.length}: ${pick.join(" | ")}`);
  }
}
main();
