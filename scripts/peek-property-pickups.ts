// property_pickups の直近の行を見る（読み取りのみ・お客様名は先頭1文字だけ）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const { data, error } = await sb.from("property_pickups").select("id, created_at, batch_id, property_customer_id, conversation_id, customer_name, site, rank, property_name, pdf_has_text, page_image_url, agent_image_url, image_lines, verdict, status").order("created_at", { ascending: false }).limit(20);
  if (error) { console.log("error:", error.message); return; }
  console.log(`直近 ${data?.length ?? 0} 行`);
  for (const r of data ?? []) console.log(`${String(r.created_at).slice(0, 19)} batch=${String(r.batch_id).slice(0, 30)} cust=${r.property_customer_id ? String(r.property_customer_id).slice(0, 8) : "-"} conv=${r.conversation_id ? String(r.conversation_id).slice(0, 8) : "-"} name=${r.customer_name ? String(r.customer_name).slice(0, 1) + "…" : "-"} site=${r.site} rank=${r.rank} text=${r.pdf_has_text} p1=${r.page_image_url ? "有" : "-"} p2=${r.agent_image_url ? "有" : "-"} lines=${Array.isArray(r.image_lines) ? r.image_lines.length : 0} verdict=${r.verdict} status=${r.status}`);
  const { count } = await sb.from("property_pickups").select("id", { count: "exact", head: true });
  console.log("合計行数:", count);
}
main().catch((e) => { console.error(e); process.exit(1); });
