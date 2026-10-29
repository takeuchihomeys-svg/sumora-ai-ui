// scripts/audit-turn-brain-calls.ts — お客様の1番に、ブレインが何回・どの道（route×action）で呼ばれたかを数える（読むだけ・LLM なし）
//   番＝お客様の連投の最初の通から、次のお客様の連投の最初の通まで（無ければ6時間）。本番（env=production）の llm_usage_logs の brain_* を数える。
// 使い方: npx tsx --env-file=.env.local scripts/audit-turn-brain-calls.ts [--days=14]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 14);
(async () => {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const msgs: Array<{ conversation_id: string; sender: string; created_at: string }> = [];
  for (let off = 0; ; off += 1000) { const { data } = await sb.from("messages").select("conversation_id, sender, created_at").gte("created_at", since).order("created_at").range(off, off + 999); msgs.push(...(data ?? [])); if (!data || data.length < 1000) break; }
  const usage: Array<{ conversation_id: string | null; action: string; route: string | null; created_at: string; input_uncached: number | null; cache_read: number | null; cache_write: number | null; output_tokens: number | null }> = [];
  for (let off = 0; ; off += 1000) { const { data } = await sb.from("llm_usage_logs").select("conversation_id, action, route, created_at, input_uncached, cache_read, cache_write, output_tokens").gte("created_at", since).like("action", "brain%").eq("env", "production").range(off, off + 999); usage.push(...((data ?? []) as typeof usage)); if (!data || data.length < 1000) break; }
  const usd = (u: (typeof usage)[number]) => ((u.input_uncached ?? 0) * 3 + (u.cache_read ?? 0) * 0.3 + (u.cache_write ?? 0) * 3.75 + (u.output_tokens ?? 0) * 15) / 1e6;
  const turnsBy = new Map<string, number[]>();
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) { const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  for (const [c, ms] of byConv) { const starts: number[] = []; for (let i = 0; i < ms.length; i++) if (ms[i].sender === "customer" && (i === 0 || ms[i - 1].sender !== "customer")) starts.push(Date.parse(ms[i].created_at)); turnsBy.set(c, starts); }
  const per = new Map<string, number>(); const cost = new Map<string, number>(); let turns = 0; const hist: Record<number, number> = {};
  const turnCalls = new Map<string, number>();
  for (const u of usage) {
    if (!u.conversation_id) continue;
    const st = turnsBy.get(u.conversation_id) ?? []; const t = Date.parse(u.created_at);
    let k = -1; for (let i = 0; i < st.length; i++) if (st[i] <= t) k = i; else break;
    const key = `${u.route ?? "-"}｜${u.action}`; per.set(key, (per.get(key) ?? 0) + 1); cost.set(key, (cost.get(key) ?? 0) + usd(u));
    const tk = `${u.conversation_id}#${k}`; turnCalls.set(tk, (turnCalls.get(tk) ?? 0) + 1);
  }
  for (const n of turnCalls.values()) { turns++; hist[Math.min(n, 8)] = (hist[Math.min(n, 8)] ?? 0) + 1; }
  console.log(`直近${days}日（本番）: ブレインの呼び出し ${usage.length}回・約 $${[...cost.values()].reduce((a, b) => a + b, 0).toFixed(1)}・呼び出しのあった番 ${turns}`);
  console.log("1番あたりの回数の分布:", Object.entries(hist).map(([k, v]) => `${k}${k === "8" ? "+" : ""}回 ${v}番`).join("・"));
  console.log("道ごと（回数・費用）:");
  for (const [k, v] of [...per].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`  ${k.padEnd(48)} ${String(v).padStart(5)}回  $${(cost.get(k) ?? 0).toFixed(2)}`);
})();
