// scripts/audit-earliest-move-in.ts — PROCEDURE_EARLIEST_MOVE_IN（「最短入居日どのくらい」を手続きの質問に）の前後を本番のお客様の発言に当てる（読むだけ・LLM なし）
//   on で新しく手続きの質問になる発言と、その後のスタッフの返事（本文か AIX か）を並べる（目で読む）。実行: npx tsx --env-file=.env.local scripts/audit-earliest-move-in.ts [--days=180]
import { supabase } from "../app/lib/supabase-server";
import { detectProcedureQuestion, isProcedureReplyQuestion } from "../app/lib/procedure-question";
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 180);
(async () => {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const { data } = await supabase.from("messages").select("conversation_id, text, created_at").eq("sender", "customer").gte("created_at", since).or("text.ilike.%最短%,text.ilike.%一番早%").order("created_at").range(0, 999);
  let n = 0;
  for (const m of (data ?? []) as Array<{ conversation_id: string; text: string | null; created_at: string }>) {
    delete process.env.PROCEDURE_EARLIEST_MOVE_IN;
    const off = isProcedureReplyQuestion(detectProcedureQuestion(m.text));
    process.env.PROCEDURE_EARLIEST_MOVE_IN = "on";
    const on = isProcedureReplyQuestion(detectProcedureQuestion(m.text));
    if (off === on) continue;
    n++;
    const { data: next } = await supabase.from("messages").select("text, is_aix_generated, created_at").eq("conversation_id", m.conversation_id).eq("sender", "staff").gt("created_at", m.created_at).order("created_at").range(0, 1);
    const s = (next ?? [])[0] as { text: string | null; is_aix_generated: boolean | null } | undefined;
    console.log(`--- ${m.created_at.slice(0, 16)} ${m.conversation_id.slice(0, 8)} C:${(m.text ?? "").replace(/\s+/g, " ").slice(0, 80)}\n    S(${s?.is_aix_generated ? "AIX" : "手打ち"}):${(s?.text ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
  }
  console.log(`\n「最短」を含む発言 ${data?.length ?? 0}・on で手続きの質問になる ${n}`);
  process.exit(0);
})();
