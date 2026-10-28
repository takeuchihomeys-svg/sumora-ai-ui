// ブレインとは別に同じ会話を LLM に読ませている呼び出しの30日の回数・費用（読むだけ・LLM なし・$0）
// 2026-10-13 竹内「ブレインを使えばよいのに使えていない部分…API も有効に使う」の棚卸し用。
// 使い方: npx tsx --env-file=.env.local scripts/audit-brain-reuse-llm-calls.ts [--days=30] [--env=production]
import { createClient } from "@supabase/supabase-js";
import { claudePriceOf, claudeUsageUsd, altPriceOf, altUsageUsd } from "../app/lib/llm-price";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const DAYS = Number(arg("days", "30"));
const ENV = arg("env", "production");
// --by=head: action が無い古い行は system の先頭（sys_head）で分ける／--by=route: 経路だけ
const BY = arg("by", "action");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");

type Row = Record<string, unknown> & { route: string | null; action: string | null; model: string | null; created_at: string };

// --decisions: brain_decision_logs の最後の一手を決めた出どころ（decision_source）ごとの数と、押された AIX との一致（79db1d9c の型）
async function decisions() {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("brain_decision_logs").select("decision_source,suggested_action,actual_aix_type,matched,conversation_status")
      .gte("created_at", since).order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const g = new Map<string, { n: number; judged: number; matched: number }>();
  for (const r of rows) {
    const src = String(r.decision_source ?? "(なし)");
    const k = src.split(":")[0] + (src.includes(":") ? ":" + src.split(":")[1].slice(0, 28) : "");
    const a = g.get(k) ?? { n: 0, judged: 0, matched: 0 };
    a.n++;
    if (r.actual_aix_type != null || r.matched != null) { a.judged++; if (r.matched === true) a.matched++; }
    g.set(k, a);
  }
  console.log(`=== brain_decision_logs ${DAYS}日: ${rows.length}行（出どころ・回数・押された AIX と比べた数・一致）===`);
  for (const [k, a] of [...g.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 45)) console.log(`${k}	${a.n}	${a.judged}	${a.matched}`);
}

async function main() {
  if (process.argv.includes("--decisions")) return decisions();
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from("llm_usage_logs")
      .select("created_at,route,action,model,status,sys_head,input_uncached,cache_read,cache_write,cache_write_5m,cache_write_1h,output_tokens,thinking_tokens,env,conversation_id")
      .gte("created_at", since).order("id", { ascending: true }).range(from, from + 999);
    if (ENV !== "all") q = q.eq("env", ENV);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  type Agg = { calls: number; usd: number; inUnc: number; read: number; w5: number; w1h: number; out: number; hits: number; convs: Set<string> };
  const g = new Map<string, Agg>();
  let total = 0;
  for (const r of rows) {
    const usd = claudePriceOf(r.model) ? claudeUsageUsd(r as never) : altPriceOf(r.model) ? altUsageUsd(r as never) : 0;
    total += usd;
    const head = String(r.sys_head ?? "").replace(/\s+/g, " ").slice(0, 40);
    const k = BY === "route" ? `${r.route ?? "-"}` : BY === "head" ? `${r.route ?? "-"} | ${r.action ?? "head:" + head}` : `${r.route ?? "-"} | ${r.action ?? "-"} | ${(r.model ?? "-").replace(/-\d{8}$/, "")}`;
    const a = g.get(k) ?? { calls: 0, usd: 0, inUnc: 0, read: 0, w5: 0, w1h: 0, out: 0, hits: 0, convs: new Set<string>() };
    a.calls++; a.usd += usd;
    a.inUnc += Number(r.input_uncached ?? 0); a.read += Number(r.cache_read ?? 0);
    a.w5 += Number(r.cache_write_5m ?? 0); a.w1h += Number(r.cache_write_1h ?? 0); a.out += Number(r.output_tokens ?? 0);
    if (Number(r.cache_read ?? 0) > 0) a.hits++;
    if (r.conversation_id) a.convs.add(String(r.conversation_id));
    g.set(k, a);
  }
  // --daily=a,b: 指定の action の日ごとの回数（JST）
  const daily = arg("daily", "");
  if (daily) {
    const want = new Set(daily.split(","));
    const d = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (!r.action || !want.has(r.action)) continue;
      const day = new Date(new Date(r.created_at).getTime() + 9 * 3600e3).toISOString().slice(5, 10);
      const m = d.get(r.action) ?? new Map<string, number>(); m.set(day, (m.get(day) ?? 0) + 1); d.set(r.action, m);
    }
    for (const [a, m] of d) console.log(`${a}: ${[...m.entries()].sort().map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  console.log(`=== llm_usage_logs ${DAYS}日 env=${ENV}: ${rows.length}行 合計 $${total.toFixed(2)} ===`);
  console.log("route | action | model\t回数\t$\t1回の入力(未キャッシュ/読み/書5m/書1h)\t出力/回\t命中%\t会話数");
  for (const [k, a] of [...g.entries()].sort((x, y) => y[1].usd - x[1].usd).slice(0, Number(arg("top", "70")))) {
    const n = a.calls;
    console.log(`${k}\t${n}\t${a.usd.toFixed(2)}\t${Math.round(a.inUnc / n)}/${Math.round(a.read / n)}/${Math.round(a.w5 / n)}/${Math.round(a.w1h / n)}\t${Math.round(a.out / n)}\t${Math.round((100 * a.hits) / n)}\t${a.convs.size}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
