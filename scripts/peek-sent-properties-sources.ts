// sent_properties の中身の形（source 別・aix 種別・紐付き）を見る（読み取りのみ・名前は出さない）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const { data: sample } = await sb.from("sent_properties").select("*").limit(1);
  console.log("列:", sample && sample[0] ? Object.keys(sample[0]).join(", ") : "-");
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("sent_properties").select("*").gte("sent_at", since).range(from, from + 999);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const by = new Map<string, number>();
  for (const r of rows) {
    const k = `source=${r.source ?? "-"} aix=${r.aix_type ?? r.send_type ?? "-"} pc=${r.property_customer_id ? "有" : "無"} conv=${r.conversation_id ? "有" : "無"} url=${r.property_url ? "有" : "無"}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  console.log(`\n14日 ${rows.length}行:`);
  for (const [k, v] of [...by.entries()].sort((a, z) => z[1] - a[1])) console.log(`  ${v}\t${k}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
