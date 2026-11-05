// scripts/exam-spend-day.ts — 1日の試験の費用（読むだけ・LLM なし）。前を作る子（script:brain-exam-main-*）も入れ、DeepSeek は表の単価（平日の倍の時間は2倍・app/lib/llm-price.ts）で数える
//   2026-11-05 作業員8（統括役「5つの直しの後の1日の試験の費用を、前（約 $39/日）と比べて」）。llm_usage_daily の est_usd は DeepSeek にも Sonnet の式を掛けていた（弱い所 310）ので使わない
// 実行: npx tsx --env-file=.env.local scripts/exam-spend-day.ts [--day=2026-11-06]（JST の日・既定 昨日）
import { createClient } from "@supabase/supabase-js";
import { altUsageUsd, altPriceOf } from "../app/lib/llm-price";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const yest = new Date(Date.now() + 9 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
const day = arg("day", yest);
const from = new Date(Date.parse(`${day}T00:00:00+09:00`)).toISOString(), to = new Date(Date.parse(`${day}T00:00:00+09:00`) + 86_400_000).toISOString();
/** Claude（Sonnet 5.x）の式（llm_usage_daily と同じ: 入力 $2・読み $0.2・書き 5m $2.5・1h $4・出力 $10 /M） */
const claudeUsd = (r: Row) => ((r.input_uncached ?? 0) * 2 + (r.cache_read ?? 0) * 0.2 + (r.cache_write_5m ?? 0) * 2.5 + (r.cache_write_1h ?? 0) * 4 + (r.output_tokens ?? 0) * 10) / 1e6;
type Row = { route: string | null; model: string | null; input_uncached: number | null; cache_read: number | null; cache_write_5m: number | null; cache_write_1h: number | null; output_tokens: number | null; created_at: string; status: number | null };
(async () => {
  const rows: Row[] = [];
  for (let i = 0; ; i += 1000) { // 1000行ずつの頁（点検表 3）
    const { data, error } = await sb.from("llm_usage_logs").select("route, model, input_uncached, cache_read, cache_write_5m, cache_write_1h, output_tokens, created_at, status")
      .gte("created_at", from).lt("created_at", to).like("route", "script:%").order("id", { ascending: true }).range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  const g = new Map<string, { n: number; usd: number }>();
  const add = (k: string, usd: number) => { const v = g.get(k) ?? { n: 0, usd: 0 }; v.n++; v.usd += usd; g.set(k, v); };
  for (const r of rows) {
    if (!(r.status != null && r.status >= 1 && r.status < 400)) continue;
    const grp = /^script:brain-exam-main-/.test(r.route ?? "") ? "前を作る子" : /^script:brain-exam/.test(r.route ?? "") ? "依頼" : "他の台本";
    const isClaude = /^claude/.test(r.model ?? "");
    add(`${grp}|${isClaude ? "Claude" : altPriceOf(r.model) ? "DeepSeek・Jev" : "他"}`, isClaude ? claudeUsd(r) : altUsageUsd(r));
  }
  const tot = [...g.values()].reduce((s, v) => s + v.usd, 0);
  console.log(`# ${day}（JST）の試験の費用（llm_usage_logs・route=script:*・DeepSeek は表の単価・倍の時間は2倍）: 合計 $${tot.toFixed(2)}（前 11/04〜05 は 約 $39/日）`);
  for (const [k, v] of [...g].sort((a, b) => b[1].usd - a[1].usd)) console.log(`- ${k.replace("|", "・")}: ${v.n}回 $${v.usd.toFixed(2)}`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
