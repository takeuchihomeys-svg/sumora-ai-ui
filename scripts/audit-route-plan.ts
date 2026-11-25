// scripts/audit-route-plan.ts — 係ごとの振り分けの案で、Claude・OpenAI・DeepSeek の月の費用がどうなるかの見込み（読むだけ・LLM なし・台帳 #670）
//   2026-11-25 作業員L（統括役の決め: 書き手は Claude／DeepSeek の2択・OpenAI は文の質に出ない係）。
//   今月の llm_usage_logs の Claude の行（試験 script:* を除く）を係（route・action・モデル）ごとに足し、案（scripts/lib/llm-route-plan.ts）で振った先の単価で
//   同じトークンを数え直す（OpenAI・DeepSeek は Claude のキャッシュの書き込みを読み込みの外れとして数える＝控えめ）。30日に伸ばして枠（Claude $200・OpenAI $100）と比べる。
//   月初から全部の行を読むので 22時〜8時に流す。
// 実行: npx tsx --env-file=.env.local scripts/audit-route-plan.ts [--until=2026-11-25T00:00:00Z] [--claude-cap=200] [--openai-cap=100]
import { createClient } from "@supabase/supabase-js";
import { altUsageUsd, claudeUsageUsd } from "../app/lib/llm-price";
import { targetOf, type PlanName, type Target } from "./lib/llm-route-plan";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Row = { id: number; route: string | null; action: string | null; model: string | null; created_at: string; status: number | null; input_uncached: number | null; cache_read: number | null; cache_write: number | null; cache_write_5m: number | null; cache_write_1h: number | null; output_tokens: number | null };

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const until = new Date(arg("until", new Date().toISOString()));
  const since = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), 1));
  const days = (until.getTime() - since.getTime()) / 86_400_000, scale = 30 / days;
  const claudeCap = Number(arg("claude-cap", "200")), openaiCap = Number(arg("openai-cap", "100"));
  const rows: Row[] = [];
  let lastId = 0;
  for (let page = 0; page < 3000; page++) {
    const { data, error } = await sb.from("llm_usage_logs").select("id, route, action, model, created_at, status, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h, output_tokens")
      .gte("created_at", since.toISOString()).lt("created_at", until.toISOString()).like("model", "claude%").gt("id", lastId).order("id", { ascending: true }).limit(1000);
    if (error) throw new Error(error.message);
    const rs = (data ?? []) as Row[];
    for (const r of rs) { lastId = Math.max(lastId, r.id); if (/^script:/.test(r.route ?? "")) continue; rows.push(r); }
    if (rs.length < 1000) break;
  }
  const now = rows.reduce((a, r) => a + claudeUsageUsd(r as never), 0);
  console.log(`# 係ごとの振り分けの案（今月 ${since.toISOString().slice(0, 10)}〜${until.toISOString().slice(0, 16)}Z・${days.toFixed(1)}日・Claude の行 ${rows.length}・試験は除く）`);
  console.log(`今の Claude: 今月 $${now.toFixed(2)} → 30日で $${(now * scale).toFixed(0)}（枠 $${claudeCap}）\n`);
  for (const plan of ["A", "B", "C", "D"] as PlanName[]) {
    const tot: Record<"claude" | "openai" | "deepseek", number> = { claude: 0, openai: 0, deepseek: 0 };
    const moved = new Map<string, { to: Target; why: string; claudeUsd: number; newUsd: number; n: number }>();
    for (const r of rows) {
      const c = claudeUsageUsd(r as never);
      const t = targetOf(plan, r.route ?? "", r.action ?? "", r.model ?? "");
      let u = c;
      if (t.to === "claude") tot.claude += c;
      else {
        const write = (r.cache_write_5m ?? 0) + (r.cache_write_1h ?? 0) + (r.cache_write ?? 0);
        const model = t.to === "deepseek" ? "deepseek-v4-pro" : t.to;
        u = altUsageUsd({ model, created_at: r.created_at, input_uncached: (r.input_uncached ?? 0) + write, cache_read: r.cache_read ?? 0, output_tokens: r.output_tokens ?? 0 } as never);
        if (t.to === "deepseek") tot.deepseek += u; else tot.openai += u;
      }
      if (t.to !== "claude") {
        const k = `${(r.route ?? "-").replace(/^\/api\//, "")} | ${r.action ?? "-"} | ${String(r.model).replace(/-\d{8}$/, "")}`;
        const m = moved.get(k) ?? { to: t.to, why: t.why, claudeUsd: 0, newUsd: 0, n: 0 };
        m.claudeUsd += c; m.newUsd += u; m.n++; moved.set(k, m);
      }
    }
    const f = (x: number) => `$${(x * scale).toFixed(0)}`;
    console.log(`## 案 ${plan}（${plan === "A" ? "書き手は Claude のまま" : plan === "B" ? "書き手は DeepSeek" : plan === "C" ? "本番＝A＋個人情報の番の書き手を OpenAI" : "C＋本番のブレインも OpenAI（既定 off）"}）: 30日で Claude ${f(tot.claude)}${tot.claude * scale <= claudeCap ? "（枠内）" : "（⚠ 枠を超える）"}・OpenAI ${f(tot.openai)}${tot.openai * scale <= openaiCap ? "（枠内）" : "（⚠ 枠を超える）"}・DeepSeek ${f(tot.deepseek)}`);
    for (const [k, m] of [...moved].sort((a, b) => b[1].claudeUsd - a[1].claudeUsd).slice(0, 20)) console.log(`- ${k}（${m.n}回）→ ${m.to}: Claude ${f(m.claudeUsd)} → ${f(m.newUsd)}・${m.why}`);
    console.log("");
  }
})().catch((e) => { console.error(e); process.exit(1); });
