// property_pickups.pdf_url の形（読み取りのみ）: クエリの鍵の名前と、値が物件ごとに違うかだけ出す（値そのものは出さない）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const { data } = await sb.from("property_pickups").select("id, batch_id, pdf_url").not("pdf_url", "is", null).limit(50);
  const rows = (data ?? []) as Array<{ id: number; batch_id: string; pdf_url: string }>;
  const perKey = new Map<string, Set<string>>();
  for (const r of rows) {
    try {
      const u = new URL(r.pdf_url);
      console.log(`#${r.id} path=${u.pathname} keys=${[...u.searchParams.keys()].join(",")}`);
      for (const [k, v] of u.searchParams) { if (!perKey.has(k)) perKey.set(k, new Set()); perKey.get(k)!.add(v); }
    } catch { console.log(`#${r.id} URL ではない`); }
  }
  for (const [k, s] of perKey) console.log(`鍵 ${k}: 異なる値 ${s.size}／${rows.length}行`);
}
main().catch((e) => { console.error(e); process.exit(1); });
