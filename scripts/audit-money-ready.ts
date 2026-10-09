// scripts/audit-money-ready.ts — 「お金を用意できる日」（payment-timing.extractMoneyReady）の当たりを全部目で読む（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-money-ready.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { extractMoneyReady, planApplyTiming, mdw } from "../app/lib/payment-timing";
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 365);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const rows: Array<{ conversation_id: string; created_at: string; text: string | null }> = [];
  for (let i = 0; ; i += 1000) { const { data, error } = await sb.from("messages").select("conversation_id, created_at, text").eq("sender", "customer").gte("created_at", since).order("created_at").range(i, i + 999); if (error) throw error; rows.push(...(data ?? [])); if ((data ?? []).length < 1000) break; }
  let n = 0;
  for (const m of rows) {
    if (isTestConversation(m.conversation_id)) continue;
    const said = Date.parse(m.created_at);
    const r = extractMoneyReady([{ text: m.text, createdAt: m.created_at }], said);
    if (!r) continue; n++;
    const p = planApplyTiming({ moneyDayMs: r.fromDayMs, nowMs: said });
    console.log(`${m.created_at.slice(0, 10)} ${m.conversation_id.slice(0, 6)} 用意 ${mdw(r.fromDayMs)}・申込の目安 ${mdw(p.applyFromMs)}〜${mdw(p.applyToMs)}（${p.decision}）「${r.quote}」`);
  }
  console.log(`当たり ${n}・お客様の発言 ${rows.length}`);
})();
