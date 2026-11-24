// scripts/audit-aix-state-doc.ts — 送った物件の資料で、項目ごとに「資料で答えられる」割合（台帳 #688・札の欠け「資料にある」・読むだけ・LLM なし・夜の重い読み）
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-state-doc.ts [--days=60]
// 2026-11-25 作業員A。読み方は contract-terms-question.routeContractTerm（返信の道と同じ網）
import { createClient } from "@supabase/supabase-js";
import { routeContractTerm } from "../app/lib/contract-terms-question";
import { DOC_TOPICS, type DocPickup } from "../app/lib/aix-state-doc";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const days = Number(arg("days") || 60);
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const rows: DocPickup[] = [];
  for (let f = 0; ; f += 200) {
    const { data, error } = await sb.from("property_pickups").select("property_name, created_at, terms, pdf_text, image_lines").eq("status", "sent").gte("created_at", new Date(Date.now() - days * 864e5).toISOString()).order("created_at").range(f, f + 199);
    if (error) throw error;
    rows.push(...((data ?? []) as DocPickup[]));
    if (!data || data.length < 200) break;
  }
  console.log(`■ 送った物件（${days}日）${rows.length}件で、項目ごとに資料で答えられる（material）割合`);
  for (const tp of DOC_TOPICS) {
    let m = 0;
    for (const r of rows) { try { if (routeContractTerm(tp, { terms: r.terms ?? null, lines: r.image_lines ?? [], pdfText: r.pdf_text ?? null }).route === "material") m++; } catch { /* */ } }
    console.log(`  ${tp}: ${m}/${rows.length}（${rows.length ? Math.round((m / rows.length) * 1000) / 10 : 0}%）`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
