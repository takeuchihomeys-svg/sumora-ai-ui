// scripts/audit-rent-question.ts — 2026-10-02 ⑫: rent-question.customerAsksRentLevel の線（読むだけ・LLM なし）。お客様の発言で当たる文を目で読む
// 実行: npx tsx --env-file=.env.local scripts/audit-rent-question.ts
import { createClient } from "@supabase/supabase-js";
import { customerAsksRentLevel } from "../app/lib/rent-question";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
(async () => {
  const seen = new Set<string>(); let n = 0;
  for (const w of ["相場", "家賃", "予算", "万"]) {
    const { data } = await sb.from("messages").select("text").eq("sender", "customer").ilike("text", `%${w}%`).order("created_at", { ascending: false }).limit(800);
    for (const m of data ?? []) { const t = String(m.text ?? ""); if (seen.has(t)) continue; seen.add(t); n++; if (customerAsksRentLevel(t)) console.log("  当たる:", t.replace(/\n/g, " ").slice(0, 100)); }
  }
  console.log("読んだお客様の発言", n);
})();
