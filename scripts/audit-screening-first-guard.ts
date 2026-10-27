// scripts/audit-screening-first-guard.ts — COMPANY_FACT_SCREENING_FIRST_GUARD（「審査だけ先に…できかねます」を会社の事実違いとする）を本番のスタッフの送信と AI の下書きに当てる（読むだけ・LLM なし）
//   スタッフの送信（365日）で当たる数＝0 が線（実送信に無い断定だけを止める）。下書き（見張り）で当たる物を目で読む。
//   実行: npx tsx --env-file=.env.local scripts/audit-screening-first-guard.ts
import { supabase } from "../app/lib/supabase-server";
import { findCompanyFactContradictionsUngated } from "../app/lib/company-fact-guard";
process.env.COMPANY_FACT_SCREENING_FIRST_GUARD = "on";
(async () => {
  const since = new Date(Date.now() - 365 * 86400e3).toISOString();
  let staffHits = 0, staffN = 0;
  for (let a = 0; ; a += 1000) {
    const { data } = await supabase.from("messages").select("text, created_at").eq("sender", "staff").gte("created_at", since).ilike("text", "%審査%").order("created_at").range(a, a + 999);
    for (const m of (data ?? []) as Array<{ text: string | null; created_at: string }>) {
      staffN++;
      const h = findCompanyFactContradictionsUngated(m.text).filter((x) => x.factId === "screening_first");
      if (h.length) { staffHits++; console.log(`スタッフ ${m.created_at.slice(0, 10)}: ${h[0].sentence.slice(0, 100)}`); }
    }
    if (!data || data.length < 1000) break;
  }
  const { data: turns } = await supabase.from("line_watch_turns").select("id, draft_last").not("draft_last", "is", null).ilike("draft_last", "%審査%").range(0, 999);
  let draftHits = 0;
  for (const t of (turns ?? []) as Array<{ id: number; draft_last: string }>) {
    const h = findCompanyFactContradictionsUngated(t.draft_last).filter((x) => x.factId === "screening_first");
    if (h.length) { draftHits++; console.log(`下書き ${t.id}: ${h[0].sentence.slice(0, 100)}`); }
  }
  console.log(`\nスタッフの送信（審査の語あり）${staffN}通で当たり ${staffHits}／見張りの下書きで当たり ${draftHits}`);
  process.exit(0);
})();
