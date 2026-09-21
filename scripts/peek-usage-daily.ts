// llm_usage_daily の形を見る（読み取りのみ）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  for (const t of ["llm_usage_daily", "llm_cost_daily", "llm_usage_logs"]) {
    const { data, error } = await sb.from(t).select("*").limit(3);
    if (error) { console.log(`\n=== ${t}: 読めない（${error.message}）===`); continue; }
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    console.log(`\n=== ${t}: ${rows.length}行のサンプル ===`);
    if (rows[0]) console.log(`   列: ${Object.keys(rows[0]).join(", ")}`);
    for (const r of rows) console.log(`   ${JSON.stringify(r).slice(0, 400)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
