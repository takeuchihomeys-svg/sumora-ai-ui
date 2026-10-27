// scripts/audit-negotiation-conditional.ts — NEGOTIATION_PROMISE_SKIP_CONDITIONAL の前後を本番のスタッフの送信に当てる（読むだけ・LLM なし）
//   交渉・申請の約束の網に当たる送信のうち、on で約束でなくなる物を全部出す（目で読む）。実行: npx tsx --env-file=.env.local scripts/audit-negotiation-conditional.ts [--days=180]
import { supabase } from "../app/lib/supabase-server";
import { negotiationPromisePending } from "../app/lib/further-discount";
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 180);
(async () => {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const rows: Array<{ conversation_id: string; text: string | null; created_at: string }> = [];
  for (let a = 0; ; a += 1000) {
    const { data, error } = await supabase.from("messages").select("conversation_id, text, created_at").eq("sender", "staff").gte("created_at", since).or("text.ilike.%交渉%,text.ilike.%申請%,text.ilike.%承認%,text.ilike.%許可%").order("created_at").range(a, a + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  let off = 0, changed = 0;
  for (const r of rows) {
    const a = negotiationPromisePending({ lastStaffText: r.text, customerAckOnly: true, reportedAfter: false, env: {} });
    const b = negotiationPromisePending({ lastStaffText: r.text, customerAckOnly: true, reportedAfter: false, env: { NEGOTIATION_PROMISE_SKIP_CONDITIONAL: "on" } });
    if (a) off++;
    if (a !== b) { changed++; console.log(`--- ${r.created_at.slice(0, 16)} ${r.conversation_id.slice(0, 8)}\n${(r.text ?? "").slice(0, 300)}`); }
  }
  console.log(`\n対象 ${rows.length}通・off で約束 ${off}・on で外れる ${changed}`);
  process.exit(0);
})();
