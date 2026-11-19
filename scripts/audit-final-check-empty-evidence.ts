// scripts/audit-final-check-empty-evidence.ts — FINAL_CHECK_DROP_EMPTY_EVIDENCE を on にする前の全件監査（読むだけ・LLM なし・費用 0）
//   2026-11-18 作業員H。見張りの番（line_watch_turns.final_check の issues）に網を当て、外れる知らせを全部並べる（目で読んで、誤って外す物が0かを見る）。
//   使い方: npx tsx --env-file=<.env.local> scripts/audit-final-check-empty-evidence.ts [--days=30]
import { createClient } from "@supabase/supabase-js";
import { shouldDropEmptyEvidence } from "../app/lib/final-check-empty-evidence";

const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "30");
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  let n = 0, issues = 0;
  const dropped: string[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id, draft_last, final_check").gte("customer_turn_at", since).not("final_check", "is", null).order("id").range(i, i + 999);
    if (error) throw new Error(error.message);
    for (const w of (data ?? []) as Array<{ id: number; draft_last: string | null; final_check: { issues?: Array<{ code?: string; evidence?: string }> } | null }>) {
      n++;
      for (const it of w.final_check?.issues ?? []) {
        issues++;
        if (shouldDropEmptyEvidence(String(it.evidence ?? ""), String(w.draft_last ?? ""), { FINAL_CHECK_DROP_EMPTY_EVIDENCE: "on" }, String(it.code ?? ""))) dropped.push(`#${w.id} ${it.code}「${String(it.evidence ?? "").slice(0, 40)}」`);
      }
    }
    if ((data ?? []).length < 1000) break;
  }
  console.log(`${days}日・見張りの番 ${n}・知らせ ${issues}・外れる ${dropped.length}`);
  for (const d of dropped) console.log(`  ${d}`);
})();
