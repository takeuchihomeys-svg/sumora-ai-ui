// scripts/audit-exam-deepseek-cache.ts — 読むだけ。手元の試験（env=local:deepseek-all）の DeepSeek の呼び出しで、
//   DeepSeek 自身のプロンプトキャッシュ（prompt_cache_hit_tokens → cache_read）がどれだけ効いているかを名札ごとに数える。
// 実行: npx tsx --env-file=.env.local scripts/audit-exam-deepseek-cache.ts [--from=2026-10-15T05:00:00Z] [--to=...]
import { createClient } from "@supabase/supabase-js";
import { altUsageUsd } from "../app/lib/llm-price";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const from = Date.parse(arg("from", "2026-10-15T05:00:00Z"));
const to = Date.parse(arg("to", new Date().toISOString()));
const envLabel = arg("env", "local:deepseek-all");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);

type Row = { created_at: string; action: string | null; model: string | null; input_uncached: number | null; cache_read: number | null; output_tokens: number | null; conversation_id: string | null };
async function main() {
  const rows: Row[] = [];
  for (let t = from; t < to; t += 6 * 3600_000) {
    const { data, error } = await sb.from("llm_usage_logs").select("created_at, action, model, input_uncached, cache_read, output_tokens, conversation_id")
      .eq("env", envLabel).gte("created_at", new Date(t).toISOString()).lt("created_at", new Date(Math.min(to, t + 6 * 3600_000)).toISOString()).limit(5000);
    if (error) { console.error(error.message); continue; }
    rows.push(...((data ?? []) as Row[]));
  }
  const by: Record<string, { n: number; unc: number; rd: number; out: number; usd: number; usdNoCache: number }> = {};
  for (const r of rows) {
    const k = `${r.action ?? "(なし)"}|${r.model ?? "?"}`;
    const a = (by[k] ??= { n: 0, unc: 0, rd: 0, out: 0, usd: 0, usdNoCache: 0 });
    const u = { model: r.model, input_uncached: r.input_uncached ?? 0, cache_read: r.cache_read ?? 0, output_tokens: r.output_tokens ?? 0, created_at: r.created_at };
    a.n++; a.unc += u.input_uncached; a.rd += u.cache_read; a.out += u.output_tokens;
    a.usd += altUsageUsd(u);
    a.usdNoCache += altUsageUsd({ ...u, input_uncached: u.input_uncached + u.cache_read, cache_read: 0 });
  }
  const tot = { n: 0, usd: 0, usdNoCache: 0, unc: 0, rd: 0 };
  console.log("名札|モデル                               回   素の入力/回  読めた/回  命中率   $      キャッシュ無しなら$");
  for (const [k, a] of Object.entries(by).sort((x, y) => y[1].usd - x[1].usd)) {
    tot.n += a.n; tot.usd += a.usd; tot.usdNoCache += a.usdNoCache; tot.unc += a.unc; tot.rd += a.rd;
    console.log(k.padEnd(44), String(a.n).padStart(4), String(Math.round(a.unc / a.n)).padStart(9), String(Math.round(a.rd / a.n)).padStart(9), `${((a.rd / Math.max(1, a.rd + a.unc)) * 100).toFixed(0)}%`.padStart(6), a.usd.toFixed(3).padStart(7), a.usdNoCache.toFixed(3).padStart(8));
  }
  console.log("合計", JSON.stringify({ n: tot.n, usd: +tot.usd.toFixed(3), usdNoCache: +tot.usdNoCache.toFixed(3), hitRate: +(tot.rd / Math.max(1, tot.rd + tot.unc)).toFixed(3) }));
}
main().catch((e) => { console.error(e); process.exit(1); });
