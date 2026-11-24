// scripts/audit-llm-month-cost.ts — 今月の llm_usage_logs の記録から出した Claude の費用が Console の値にどれだけ合うか（読むだけ・LLM なし）
// 2026-11-24 作業員L（台帳 #670・竹内さんの画面 11/24 10:19 JST「今月 $291.71」）。合わない分は CLAUDE_COST_FACTOR（= Console ÷ 記録）の案にする。
//   月初（UTC）から --until まで全部の行を読むので、22時〜8時に流す（営業時間に全件を読まない）。
// 実行: npx tsx --env-file=.env.local scripts/audit-llm-month-cost.ts [--until=2026-11-24T01:19:00Z] [--console=291.71]
import { createClient } from "@supabase/supabase-js";
import { claudeUsageUsd, claudePriceOf, altUsageUsd } from "../app/lib/llm-price";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const until = new Date(arg("until", "2026-11-24T01:19:00Z")).toISOString();
  const consoleUsd = Number(arg("console", "291.71"));
  const d = new Date(until);
  const since = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  const byModel = new Map<string, { n: number; usd: number; unknown: number }>();
  // 2026-11-24（統括役の頼み）: Console との差の出どころを route ごと・日ごとに（記録に無い呼び出しの疑い）
  const byRoute = new Map<string, { n: number; usd: number }>(), byDay = new Map<string, number>();
  let other = 0, lastId = 0, rows = 0;
  for (let page = 0; page < 2000; page++) {
    const { data, error } = await sb.from("llm_usage_logs").select("id, model, route, action, created_at, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h, output_tokens, status")
      .gte("created_at", since).lt("created_at", until).gt("id", lastId).order("id", { ascending: true }).limit(1000);
    if (error) throw new Error(error.message);
    const rs = (data ?? []) as Array<{ id: number; model: string | null; status: number | null } & Record<string, unknown>>;
    for (const r of rs) {
      lastId = Math.max(lastId, Number(r.id)); rows++;
      const m = String(r.model ?? "");
      if (/claude/.test(m)) {
        const e = byModel.get(m) ?? { n: 0, usd: 0, unknown: 0 };
        e.n++;
        if (!claudePriceOf(m)) e.unknown++;
        const usd = claudeUsageUsd(r as never);
        e.usd += usd;
        byModel.set(m, e);
        const rk = `${String((r as { route?: unknown }).route ?? "(なし)").replace(/^script:brain-exam-.*/, "script:brain-exam-*")} | ${String((r as { action?: unknown }).action ?? "")}`;
        const x = byRoute.get(rk) ?? { n: 0, usd: 0 }; x.n++; x.usd += usd; byRoute.set(rk, x);
        const day = new Date(Date.parse(String((r as { created_at?: unknown }).created_at)) + 9 * 3600e3).toISOString().slice(0, 10); byDay.set(day, (byDay.get(day) ?? 0) + usd);
      } else other += altUsageUsd(r as never);
    }
    if (rs.length < 1000) break;
  }
  const claude = [...byModel.values()].reduce((a, x) => a + x.usd, 0);
  console.log(JSON.stringify({ since, until, rows, claudeUsd: +claude.toFixed(2), consoleUsd, factor: claude ? +(consoleUsd / claude).toFixed(4) : null, otherUsd: +other.toFixed(2),
    byDay: [...byDay.entries()].sort().map(([d, u]) => ({ d, usd: +u.toFixed(2) })),
    byRoute: [...byRoute.entries()].sort((a, b) => b[1].usd - a[1].usd).slice(0, 25).map(([k, x]) => ({ k, n: x.n, usd: +x.usd.toFixed(2) })),
    byModel: [...byModel.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([m, x]) => ({ m, n: x.n, usd: +x.usd.toFixed(2), unknownPrice: x.unknown })) }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
