// sent_properties.property_url の鍵の形（読み取りのみ）: 同じ値が何行に入っているか（鍵として物件を1件ずつ指しているか）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const rows: Array<{ property_url: string | null; source: string | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("sent_properties").select("property_url, source").gte("sent_at", since).not("property_url", "is", null).range(from, from + 999);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  const by = new Map<string, number>();
  for (const r of rows) by.set(String(r.property_url), (by.get(String(r.property_url)) ?? 0) + 1);
  const top = [...by.entries()].sort((a, z) => z[1] - a[1]).slice(0, 8);
  console.log(`30日 property_url あり ${rows.length}行・異なる値 ${by.size}`);
  for (const [k, v] of top) console.log(`  ${v}\t${k.slice(0, 80)}`);
  const src = new Map<string, number>();
  for (const r of rows) src.set(r.source ?? "-", (src.get(r.source ?? "-") ?? 0) + 1);
  console.log("source 別:", Object.fromEntries(src));
}
main().catch((e) => { console.error(e); process.exit(1); });
