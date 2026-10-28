// scripts/audit-company-facts-1028.ts — 10/28 の会社の事実3つ（新着の出方・審査の2段・入居日と日割）がお客様の発言 365日でどれだけ当たるかを数え、当たった発言を並べる（読むだけ）
// 実行: COMPANY_FACT_1028=on npx tsx --env-file=.env.local scripts/audit-company-facts-1028.ts [--days=365] [--show=12]
import { createClient } from "@supabase/supabase-js";
import { COMPANY_FACTS } from "../app/lib/company-facts";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const IDS = ["new_listing_timing", "screening_two_stage", "move_in_day_prorated"];
(async () => {
  process.env.COMPANY_FACT_1028 = "on";
  const facts = COMPANY_FACTS.filter((f) => IDS.includes(f.id));
  const since = new Date(Date.now() - Number(arg("days", "365")) * 86400_000).toISOString();
  const hits = new Map<string, string[]>(IDS.map((i) => [i, []]));
  let n = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("text").eq("sender", "customer").gte("created_at", since).not("text", "is", null).order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ text: string }>) {
      n++;
      for (const f of facts) { const t = r.text; if ((typeof f.ask === "function" ? f.ask(t) : f.ask.test(t)) && !(f.not && f.not.test(t))) hits.get(f.id)!.push(t); }
    }
    if ((data ?? []).length < 1000) break;
  }
  console.log(`お客様の発言 ${n}通`);
  for (const [id, ts] of hits) { console.log(`\n== ${id}: ${ts.length}通`); for (const t of ts.slice(-Number(arg("show", "12")))) console.log("  " + t.replace(/\s+/g, " ").slice(0, 90)); }
  process.exit(0);
})();
