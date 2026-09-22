// ブレインの呼び出しを「毎回の分析（fresh）」と「会話全体の分析（combined/full）」に分けて費用を概算する（読み取りのみ）
// 2026-09-23 竹内「フル分析はクロード、毎回の限定的な分析は deepseek」→ どれだけ効くかの見積もり
//   ※ 層の名札（brain_fresh / brain_full）を付けたのは今日なので、それ以前は**出力の大きさ**で概算する
//     （毎回の分析は JSON が小さく、全体の分析は要約・戦略を含むので大きい）
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-layer-split.ts [DAYS=14]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const BRAIN_ROUTES = ["/api/generate-draft-bg-async", "/api/line-webhook", "/api/send-line-message", "/api/cron/brain-sweep", "/api/cron/generate-pending-drafts"];
const SONNET = { in: 3, read: 0.3, write: 3.75, out: 15 };
const DS_PRO = { in: 0.66, read: 0.022, write: 0.66, out: 1.98 };
const cost = (r: { input_uncached: number; cache_read: number; cache_write: number; output_tokens: number }, p: typeof SONNET) =>
  (r.input_uncached * p.in + r.cache_read * p.read + r.cache_write * p.write + r.output_tokens * p.out) / 1e6;

async function main() {
  const days = Number(process.env.DAYS ?? 14);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Array<{ route: string; model: string; input_uncached: number; cache_read: number; cache_write: number; output_tokens: number; action: string | null }> = [];
  for (let p = 0; p < 40; p++) {
    const { data } = await sb.from("llm_usage_logs").select("route, model, input_uncached, cache_read, cache_write, output_tokens, action")
      .in("route", BRAIN_ROUTES).gte("created_at", since).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof rows; rows.push(...r); if (r.length < 1000) break;
  }
  const brain = rows.filter((r) => /sonnet|opus/.test(r.model ?? "") && (r.output_tokens ?? 0) > 100);
  // 名札があればそれで分ける。無ければ出力1,200トークンを境にする（毎回の分析は中央値600前後）
  const isFresh = (r: typeof brain[number]) => (r.action ? r.action === "brain_fresh" : (r.output_tokens ?? 0) < 1200);
  const fresh = brain.filter(isFresh), full = brain.filter((r) => !isFresh(r));
  const sum = (a: typeof brain, p: typeof SONNET) => a.reduce((s, r) => s + cost(r, p), 0);
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "-");
  const freshNow = sum(fresh, SONNET), fullNow = sum(full, SONNET), freshDs = sum(fresh, DS_PRO);
  console.log(`直近${days}日のブレイン（${BRAIN_ROUTES.length}経路・出力100トークン超）: ${brain.length}回 ／ 今の費用 $${(freshNow + fullNow).toFixed(2)}`);
  console.log(`  毎回の分析（fresh 相当）: ${fresh.length}回（${pct(fresh.length, brain.length)}）・$${freshNow.toFixed(2)}`);
  console.log(`  全体の分析（full 相当）  : ${full.length}回（${pct(full.length, brain.length)}）・$${fullNow.toFixed(2)}`);
  console.log(`\n  毎回の分析を DeepSeek(v4-pro) にした場合: $${freshDs.toFixed(2)}（今より $${(freshNow - freshDs).toFixed(2)} 減・${days}日）`);
  console.log(`  → 1か月あたり およそ $${(((freshNow - freshDs) / days) * 30).toFixed(0)} の節約`);
  const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  console.log(`\n  1回あたり（中央値）: 入力 ${med(brain.map((r) => (r.input_uncached ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0)))} トークン ／ 出力 ${med(brain.map((r) => r.output_tokens ?? 0))} トークン`);
}
main().catch((e) => { console.error(e); process.exit(1); });
