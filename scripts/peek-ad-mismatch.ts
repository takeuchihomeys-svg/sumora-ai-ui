// 売上サポの AD の札（画面）と採点の AD の段が食い違う行をたどる（読み取りのみ）
//   npx tsx --env-file=.env.local scripts/peek-ad-mismatch.ts [物件名の一部]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const q = process.argv[2] ?? "TIO岸和田";
  const { data, error } = await sb.from("property_pickups").select("*").ilike("property_name", `%${q}%`).order("created_at", { ascending: false }).limit(5);
  if (error) { console.log(error.message); return; }
  for (const r of data ?? []) {
    console.log("=====", r.id, r.created_at, String(r.customer_name ?? "").slice(0, 1), r.site, r.property_name, r.room_no, "score", r.score, r.verdict, "ad_yen", r.ad_yen);
    console.log("summary:\n" + r.summary_text);
    console.log("codes:", r.reason_codes);
    console.log("reasons:", r.reasons_ja);
    console.log("image_lines:", JSON.stringify(r.image_lines)?.slice(0, 1500));
    console.log("image_facts:", JSON.stringify(r.image_facts)?.slice(0, 800));
    console.log("terms:", JSON.stringify(r.terms)?.slice(0, 800));
    const t = String(r.pdf_text ?? "");
    const i = t.search(/広告|AD|ＡＤ/);
    console.log("pdf_text AD 付近:", i >= 0 ? t.slice(Math.max(0, i - 150), i + 200) : "(なし)", "len", t.length);
    const skip = ["summary_text", "pdf_text", "reason_codes", "reasons_ja", "image_lines", "image_facts", "terms"];
    const other = Object.keys(r).filter((k) => !skip.includes(k));
    console.log("other:", JSON.stringify(Object.fromEntries(other.map((k) => [k, typeof r[k] === "string" && r[k].length > 120 ? r[k].slice(0, 120) : r[k]]))).slice(0, 2500));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
