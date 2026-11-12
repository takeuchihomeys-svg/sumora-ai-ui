// scripts/w21-peek-fc.ts — 作業員21（夜の読み）: 最終チェックの指摘が出た番の、書き直し後の下書き・指摘・結末を並べる（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/w21-peek-fc.ts --ids=<id8>,<id8>
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const ids = (process.argv.find((a) => a.startsWith("--ids=")) ?? "--ids=").slice(6).split(",").filter(Boolean);
(async () => {
  const { data } = await sb.from("ai_reply_examples")
    .select("id, created_at, conversation_id, was_ai_modified, ai_similarity, s:reply_context_snapshot")
    .gte("created_at", "2026-10-29").order("created_at");
  for (const r of (data ?? []) as any[]) {
    if (!ids.some((i) => String(r.id).startsWith(i))) continue;
    const s = r.s ?? {};
    console.log(`=== ${String(r.id).slice(0, 8)} conv=${String(r.conversation_id).slice(0, 8)} mod=${r.was_ai_modified} sim=${r.ai_similarity} outcome=${s.revisionOutcome} scene=${s.replyScene} action=${s.effectiveAction}`);
    console.log(`  pre: ${JSON.stringify(s.preRevisionCodes)}`);
    console.log(`  fin: ${JSON.stringify(s.finalCheckCodes)} gate=${JSON.stringify(s.finalCheckGate)?.slice(0, 160)}`);
    console.log(`  last staff: ${String(s.lastStaffMsgHead ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
    console.log(`  draft: ${String(s.draftHead ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
  }
})();
