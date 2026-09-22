// ブレインの費用と回数を「モード（毎回の分析／全体の分析）」と「モデル」で数える（読み取りのみ）
// 2026-09-23 竹内「ブレインのフル分析はクロードやけど、毎回の限定的な分析の部分は deepseek が行う形は出来るのか？」
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-cost-mode.ts [DAYS=14]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 1M トークンあたりの単価（USD）。2026-09 時点 */
const PRICE: Record<string, { in: number; cacheRead: number; cacheWrite: number; out: number }> = {
  "claude-sonnet-4-5": { in: 3, cacheRead: 0.3, cacheWrite: 3.75, out: 15 },
  "claude-sonnet-5": { in: 3, cacheRead: 0.3, cacheWrite: 3.75, out: 15 },
  "claude-haiku-4-5": { in: 1, cacheRead: 0.1, cacheWrite: 1.25, out: 5 },
  "deepseek-v4-pro": { in: 0.66, cacheRead: 0.022, cacheWrite: 0.66, out: 1.98 },
  "deepseek-flash": { in: 0.15, cacheRead: 0.003, cacheWrite: 0.15, out: 0.6 },
};
function priceOf(model: string) {
  for (const k of Object.keys(PRICE)) if (model.includes(k)) return PRICE[k];
  return null;
}
const usd = (r: { input_uncached: number | null; cache_read: number | null; cache_write: number | null; output_tokens: number | null; model: string }) => {
  const p = priceOf(r.model ?? ""); if (!p) return 0;
  return ((r.input_uncached ?? 0) * p.in + (r.cache_read ?? 0) * p.cacheRead + (r.cache_write ?? 0) * p.cacheWrite + (r.output_tokens ?? 0) * p.out) / 1e6;
};

async function main() {
  const days = Number(process.env.DAYS ?? 14);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("llm_usage_logs")
      .select("created_at, route, model, action, input_uncached, cache_read, cache_write, output_tokens, duration_ms, status, sys_key, conversation_id")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.log("⚠", error.message); break; }
    const r = (data ?? []) as typeof rows; rows.push(...r); if (r.length < 1000) break;
  }
  console.log(`=== 直近${days}日の LLM 呼び出し ${rows.length}件 ===\n`);

  type Agg = { n: number; usd: number; inTok: number; outTok: number; ms: number[] };
  const byRouteModel = new Map<string, Agg>();
  for (const r0 of rows) {
    const r = r0 as unknown as { route: string; model: string; input_uncached: number; cache_read: number; cache_write: number; output_tokens: number; duration_ms: number };
    const k = `${r.route ?? "?"} ｜ ${r.model ?? "?"}`;
    const a = byRouteModel.get(k) ?? { n: 0, usd: 0, inTok: 0, outTok: 0, ms: [] };
    a.n++; a.usd += usd(r as never);
    a.inTok += (r.input_uncached ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0);
    a.outTok += r.output_tokens ?? 0;
    if (r.duration_ms) a.ms.push(r.duration_ms);
    byRouteModel.set(k, a);
  }
  console.log("経路 ｜ モデル                                回数    費用(USD)   入力(平均)  出力(平均)  所要(中央値ms)");
  for (const [k, a] of [...byRouteModel.entries()].sort((x, y) => y[1].usd - x[1].usd)) {
    const ms = a.ms.sort((p, q) => p - q);
    console.log(`${k.padEnd(46)} ${String(a.n).padStart(5)}  ${a.usd.toFixed(2).padStart(9)}  ${String(Math.round(a.inTok / a.n)).padStart(9)}  ${String(Math.round(a.outTok / a.n)).padStart(9)}  ${String(ms[Math.floor(ms.length / 2)] ?? 0).padStart(12)}`);
  }

  // ブレインの回数（モードは brain:mode のログに出るがここでは会話×時刻の粒度で概算）
  const brain = rows.filter((r) => String((r as { route?: string }).route ?? "").includes("brain") || String((r as { sys_key?: string }).sys_key ?? "").includes("brain"));
  const brainUsd = brain.reduce((s, r) => s + usd(r as never), 0);
  console.log(`\nブレインらしき呼び出し: ${brain.length}件 ／ 費用 $${brainUsd.toFixed(2)}（${days}日）`);
  const models = new Map<string, number>();
  for (const r of brain) models.set(String((r as { model?: string }).model ?? "?"), (models.get(String((r as { model?: string }).model ?? "?")) ?? 0) + 1);
  console.log(`   モデル別: ${[...models.entries()].map(([m, n]) => `${m} ${n}`).join(" ／ ")}`);
  console.log(`\n※ 費用は 2026-09 の単価で計算（混雑時の倍額は見ていない）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
