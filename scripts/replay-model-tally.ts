// scripts/replay-model-tally.ts — YUMA の再生テストの間の LLM 呼び出しをモデル別に数える（llm_usage_logs・読むだけ）
//   「試行錯誤は DeepSeek・最終だけ Claude」が守られたかを確かめる（feedback_test_generation_deepseek）
// 実行: npx tsx --env-file=.env.local scripts/replay-model-tally.ts --since=2026-10-01T10:00:00Z [--until=…]
import { createClient } from "@supabase/supabase-js";
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
(async () => {
  const since = arg("since"), until = arg("until", new Date().toISOString());
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 50_000; i += 1000) {
    const { data, error } = await sb.from("llm_usage_logs").select("model, env, action, route, conversation_id").eq("conversation_id", "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7").gte("created_at", since).lte("created_at", until).range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Array<Record<string, unknown>>));
    if ((data ?? []).length < 1000) break;
  }
  const by = new Map<string, { n: number; usd: number }>();
  for (const r of rows) { const k = `${String(r.model)} | ${String(r.env)}`; const c = by.get(k) ?? { n: 0, usd: 0 }; c.n++; by.set(k, c); }
  const total = rows.length, ds = rows.filter((r) => /deepseek/i.test(String(r.model))).length, cl = rows.filter((r) => /claude|sonnet|haiku|opus/i.test(String(r.model))).length;
  console.log(`YUMA ${since} 〜 ${until}: 全 ${total}・DeepSeek ${ds}（${total ? Math.round(ds / total * 100) : 0}%）・Claude ${cl}・その他 ${total - ds - cl}`);
  for (const [k, c] of [...by].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(48)} ${String(c.n).padStart(5)}  $${c.usd.toFixed(3)}`);
})().catch((e) => { console.error(e); process.exit(1); });
