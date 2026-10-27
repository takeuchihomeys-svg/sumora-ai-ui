// scripts/audit-resume-advice.ts — LEDGER_RESUME_ADVICE_NOT_PROMISE の前後を本番のスタッフの送信に当てる（読むだけ・LLM なし）
//   off で pickup_declared（約束）・on で約束でなくなる送信を全部出す（目で読む）。
//   実行: npx tsx --env-file=.env.local scripts/audit-resume-advice.ts [--days=180]
import { supabase } from "../app/lib/supabase-server";
import { classifyStaffTextFacts } from "../app/lib/action-ledger";

const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 180);
(async () => {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const rows: Array<{ conversation_id: string; text: string | null; created_at: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("messages").select("conversation_id, text, created_at").eq("sender", "staff").gte("created_at", since)
      .or("text.ilike.%探し%,text.ilike.%再開%").order("created_at").range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  let offN = 0, changed = 0;
  for (const r of rows) {
    delete process.env.LEDGER_RESUME_ADVICE_NOT_PROMISE;
    const off = classifyStaffTextFacts(r.text ?? "", r.created_at).some((e) => e.kind === "pickup_declared");
    process.env.LEDGER_RESUME_ADVICE_NOT_PROMISE = "on";
    const on = classifyStaffTextFacts(r.text ?? "", r.created_at).some((e) => e.kind === "pickup_declared");
    if (off) offN++;
    if (off !== on) {
      changed++;
      console.log(`--- ${r.created_at.slice(0, 16)} ${r.conversation_id.slice(0, 8)} off=${off} on=${on}\n${(r.text ?? "").slice(0, 400)}`);
    }
  }
  console.log(`\n対象 ${rows.length}通・off で約束 ${offN}・on で変わる ${changed}`);
  process.exit(0);
})();
