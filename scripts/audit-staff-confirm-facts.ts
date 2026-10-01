// scripts/audit-staff-confirm-facts.ts — 自動返信の下書きが「スタッフしか確かめられない事実」を言い切っている物を全部出す（読むだけ・LLM なし）
// 2026-10-02 竹内さんの決定「スタッフの確認が要る物は AIX で止める」: app/lib/staff-confirm-facts.ts findStaffOnlyFact の線を、
//   返信生成の下書き（ai_reply_examples.ai_draft・entry_source=line_reply）に当てて目で読む。止めるだけ（本文は変えない）なので、
//   見るのは「止めすぎ」（スタッフが確かめずに書ける文まで止めていないか）。
// 実行: npx tsx --env-file=.env.local scripts/audit-staff-confirm-facts.ts [--days=90]
import { createClient } from "@supabase/supabase-js";
import { findStaffOnlyFact } from "../app/lib/staff-confirm-facts";
import { isTestConversation } from "../app/lib/test-conversations";
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "90");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Array<{ conversation_id: string | null; created_at: string; ai_draft: string | null; sent_reply: string | null; was_ai_modified: boolean | null }> = [];
  for (let i = 0; ; i += 1000) {
    const r = await sb.from("ai_reply_examples").select("conversation_id, created_at, ai_draft, sent_reply, was_ai_modified").eq("entry_source", "line_reply").not("ai_draft", "is", null).gte("created_at", since).order("created_at").range(i, i + 999);
    if (r.error) throw r.error; rows.push(...(r.data as typeof rows)); if ((r.data ?? []).length < 1000) break;
  }
  const tally = new Map<string, { draft: number; keptBySent: number }>();
  let n = 0;
  for (const e of rows) {
    if (!e.ai_draft || (e.conversation_id && isTestConversation(e.conversation_id))) continue;
    n++;
    const h = findStaffOnlyFact(e.ai_draft);
    if (!h) continue;
    const sentHit = findStaffOnlyFact(e.sent_reply);
    const c = tally.get(h.kind) ?? { draft: 0, keptBySent: 0 }; c.draft++; if (sentHit?.kind === h.kind) c.keptBySent++; tally.set(h.kind, c);
    console.log(`[${h.kind}] ${e.created_at.slice(0, 10)} ${sentHit?.kind === h.kind ? "送った文にも" : "送った文では消えた"}｜下書き: ${h.text.slice(0, 110)}｜送った: ${(sentHit?.text ?? (e.sent_reply ?? "").replace(/\n/g, " ")).slice(0, 80)}`);
  }
  console.log(`\n返信生成の下書き ${n}件（${DAYS}日）`);
  for (const [k, c] of tally) console.log(`  ${k}: 下書きに ${c.draft}・スタッフが送った文にも残した ${c.keptBySent}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
