// 直近の物件候補（property_candidate_pools）の AD の取れ方を見る（読み取りのみ・お客様名は出さない）
// 実行: npx tsx --env-file=.env.local scripts/peek-candidate-pool-ad.ts [--hours=6] [--customer=<id先頭>]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const hours = Number(arg("hours") ?? "6");
const cust = arg("customer");
async function main() {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data: sample } = await sb.from("property_candidate_pools").select("*").limit(1);
  const cols = sample && sample[0] ? Object.keys(sample[0] as object) : [];
  console.log("列:", cols.join(", "));
  let q = sb.from("property_candidate_pools").select("*").gte("sent_at", since).order("sent_at", { ascending: false }).limit(60);
  const { data, error } = await q;
  if (error) { console.log("error:", error.message); return; }
  const rows = ((data ?? []) as Array<Record<string, unknown>>).filter((r) => !cust || String(r.property_customer_id ?? "").startsWith(cust));
  console.log(`\n${hours}時間: ${rows.length}行`);
  for (const r of rows) {
    const name = String(r.property_name ?? r.name ?? "").slice(0, 14);
    const raw = String(r.raw_text ?? r.summary ?? r.description ?? "").replace(/\n/g, " / ").slice(0, 160);
    console.log(`${String(r.sent_at).slice(11, 16)} cust=${String(r.property_customer_id ?? "").slice(0, 8)} ${name} ad_months=${r.ad_months ?? "-"} ad_yen=${r.ad_yen ?? "-"} rent=${r.rent ?? "-"} sent=${r.was_sent ?? r.selected ?? "-"}\n    ${raw}`);
    const cands = Array.isArray(r.candidates) ? (r.candidates as Array<Record<string, unknown>>) : [];
    for (const c of cands) {
      const keys = Object.keys(c).filter((k) => !/text|summary|desc|url/i.test(k));
      console.log(`    - ${String(c.name ?? c.property_name ?? "").slice(0, 16)} | ${keys.map((k) => `${k}=${JSON.stringify(c[k])}`).join(" ").slice(0, 260)}`);
      const t = c.texts ?? c.raw_texts ?? null;
      if (t) console.log(`      texts: ${JSON.stringify(t).slice(0, 300)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
