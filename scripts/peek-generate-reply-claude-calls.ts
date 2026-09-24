// generate-reply 経路で Claude に残っている呼び出しの内訳（読み取りのみ）
// 2026-09-24 竹内「返信生成は DeepSeek に回しているはずやから、どこでそんなことが起きているのか」
// 実行: npx tsx --env-file=.env.local scripts/peek-generate-reply-claude-calls.ts [--days=1] [--route=generate-reply]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const days = Number(arg("days") ?? "1");
const route = arg("route") ?? "generate-reply";
const PRICE: Record<string, [number, number, number, number, number]> = { haiku: [1, 0.1, 1.25, 2, 5], sonnet: [3, 0.3, 3.75, 6, 15], opus: [5, 0.5, 6.25, 10, 25], deepseek: [0.28, 0.028, 0, 0, 0.42] };
type Row = { created_at: string; route: string | null; action: string | null; model: string | null; status: number | null; sys_head: string | null; input_uncached: number; cache_read: number; cache_write_5m: number; cache_write_1h: number; cache_write: number; output_tokens: number; thinking_tokens: number; stop_reason: string | null; conversation_id: string | null; duration_ms: number | null };
function tier(m: string | null) { const s = (m ?? "").toLowerCase(); return s.includes("haiku") ? "haiku" : s.includes("opus") ? "opus" : s.includes("deepseek") ? "deepseek" : "sonnet"; }
function usd(r: Row): number {
  const p = PRICE[tier(r.model)];
  const w5 = r.cache_write_5m || (r.cache_write_1h ? 0 : r.cache_write) || 0;
  return (r.input_uncached * p[0] + r.cache_read * p[1] + w5 * p[2] + (r.cache_write_1h || 0) * p[3] + (r.output_tokens + (r.thinking_tokens || 0)) * p[4]) / 1e6;
}
async function main() {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("llm_usage_logs").select("created_at, route, action, model, status, sys_head, env, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens, thinking_tokens, stop_reason, conversation_id, duration_ms")
      .gte("created_at", since).ilike("route", `%${route}%`).order("created_at", { ascending: true }).range(from, from + 999);
    if (error) { console.log(error.message); process.exit(1); }
    const chunk = (data ?? []) as Row[];
    rows.push(...chunk);
    if (chunk.length < 1000) break;
  }
  console.log(`=== route ~ ${route} の ${days}日分: ${rows.length}行 ===`);
  const groups = new Map<string, { n: number; usd: number; inU: number; read: number; out: number; err: number; convs: Set<string>; sample: string }>();
  for (const r of rows) {
    const key = `${(r as Row & { env?: string | null }).env ?? "-"} | ${tier(r.model)} | ${r.action ?? "-"} | ${(r.sys_head ?? "").replace(/\s+/g, " ").slice(0, 60)}`;
    const g = groups.get(key) ?? { n: 0, usd: 0, inU: 0, read: 0, out: 0, err: 0, convs: new Set(), sample: r.model ?? "" };
    g.n++; g.usd += usd(r); g.inU += r.input_uncached; g.read += r.cache_read; g.out += r.output_tokens + (r.thinking_tokens || 0);
    if (r.status && r.status >= 400) g.err++;
    if (r.conversation_id) g.convs.add(r.conversation_id);
    groups.set(key, g);
  }
  const total = rows.reduce((a, r) => a + usd(r), 0);
  console.log(`合計 $${total.toFixed(2)}\n`);
  console.log("回数 | $ | 平均 未キャッシュ/読み/出力 | エラー | 会話数 | モデル | action | system の先頭");
  for (const [k, g] of [...groups.entries()].sort((x, y) => y[1].usd - x[1].usd)) {
    console.log(`${g.n} | $${g.usd.toFixed(2)} | ${Math.round(g.inU / g.n)}/${Math.round(g.read / g.n)}/${Math.round(g.out / g.n)} | ${g.err} | ${g.convs.size} | ${k}`);
  }
  // 会話あたりの回数（1通の返信で何回 Claude を呼ぶか）
  const perConv = new Map<string, number>();
  for (const r of rows) if (r.conversation_id && tier(r.model) !== "deepseek") perConv.set(r.conversation_id, (perConv.get(r.conversation_id) ?? 0) + 1);
  const vals = [...perConv.values()].sort((a, b) => a - b);
  if (vals.length) console.log(`\nClaude の呼び出し 会話あたり: 会話 ${vals.length}・中央値 ${vals[Math.floor(vals.length / 2)]}・最大 ${vals[vals.length - 1]}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
