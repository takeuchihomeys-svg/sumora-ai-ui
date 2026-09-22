// 影の比較で実際に走った DeepSeek のブレイン呼び出しから、キャッシュの効き方と1回あたりの費用を実測する（読み取りのみ）
// 2026-09-23 竹内「これプロンプトキャッシュ効くからもっと節約できるのでは？」
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-deepseek-cache.ts [HOURS=24]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const PRICE = {
  "claude-sonnet": { in: 3, read: 0.3, write: 3.75, out: 15 },
  "deepseek-v4-pro": { in: 0.66, read: 0.022, write: 0.66, out: 1.98 },
  "deepseek-flash": { in: 0.15, read: 0.003, write: 0.15, out: 0.6 },
};
type Row = { created_at: string; model: string; action: string | null; route: string; input_uncached: number | null; cache_read: number | null; cache_write: number | null; output_tokens: number | null };
const cost = (r: Row, p: { in: number; read: number; write: number; out: number }) =>
  ((r.input_uncached ?? 0) * p.in + (r.cache_read ?? 0) * p.read + (r.cache_write ?? 0) * p.write + (r.output_tokens ?? 0) * p.out) / 1e6;
const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;

async function main() {
  const hours = Number(process.env.HOURS ?? 24);
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data } = await sb.from("llm_usage_logs")
    .select("created_at, model, action, route, input_uncached, cache_read, cache_write, output_tokens")
    .gte("created_at", since).order("created_at");
  const rows = (data ?? []) as Row[];
  const ds = rows.filter((r) => /deepseek/.test(r.model ?? "") && (r.action ?? "").startsWith("brain_"));
  const cl = rows.filter((r) => /sonnet/.test(r.model ?? "") && (r.output_tokens ?? 0) > 100 &&
    ["/api/generate-draft-bg-async", "/api/line-webhook", "/api/send-line-message", "/api/cron/brain-sweep", "/api/cron/generate-pending-drafts"].includes(r.route));
  console.log(`直近${hours}時間: DeepSeek のブレイン ${ds.length}回 ／ Claude のブレイン ${cl.length}回\n`);
  if (ds.length) {
    const tot = (r: Row) => (r.input_uncached ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0);
    const hit = ds.map((r) => (r.cache_read ?? 0) / Math.max(tot(r), 1));
    console.log(`【DeepSeek（実測）】`);
    console.log(`   入力の合計（中央値） ${med(ds.map(tot))} トークン ／ うちキャッシュ一致 ${med(ds.map((r) => r.cache_read ?? 0))}（一致率 ${(med(hit) * 100).toFixed(1)}%）`);
    console.log(`   キャッシュ不一致（中央値） ${med(ds.map((r) => r.input_uncached ?? 0))} ／ 出力 ${med(ds.map((r) => r.output_tokens ?? 0))}`);
    const per = ds.map((r) => cost(r, PRICE["deepseek-v4-pro"]));
    const perFlash = ds.map((r) => cost(r, PRICE["deepseek-flash"]));
    const perIfClaude = ds.map((r) => cost(r, PRICE["claude-sonnet"]));
    console.log(`   1回あたり: v4-pro $${med(per).toFixed(4)} ／ flash なら $${med(perFlash).toFixed(4)} ／ 同じ内訳を Claude 単価で $${med(perIfClaude).toFixed(4)}`);
  }
  if (cl.length) {
    const tot = (r: Row) => (r.input_uncached ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0);
    const hit = cl.map((r) => (r.cache_read ?? 0) / Math.max(tot(r), 1));
    console.log(`\n【Claude（実測・本番のブレイン）】`);
    console.log(`   入力の合計（中央値） ${med(cl.map(tot))} ／ うちキャッシュ一致 ${med(cl.map((r) => r.cache_read ?? 0))}（一致率 ${(med(hit) * 100).toFixed(1)}%）・書き込み ${med(cl.map((r) => r.cache_write ?? 0))}`);
    console.log(`   1回あたり $${med(cl.map((r) => cost(r, PRICE["claude-sonnet"]))).toFixed(4)}`);
  }
  if (ds.length && cl.length) {
    const perDs = med(ds.map((r) => cost(r, PRICE["deepseek-v4-pro"])));
    const perFl = med(ds.map((r) => cost(r, PRICE["deepseek-flash"])));
    const perCl = med(cl.map((r) => cost(r, PRICE["claude-sonnet"])));
    const perMonth = 1301 / 14 * 30;   // 毎回の分析の回数（直近14日の実測から）
    console.log(`\n【月あたりの見込み（毎回の分析 ${Math.round(perMonth)}回）】`);
    console.log(`   今（Claude）        $${(perCl * perMonth).toFixed(0)}`);
    console.log(`   DeepSeek v4-pro     $${(perDs * perMonth).toFixed(0)}（差 $${((perCl - perDs) * perMonth).toFixed(0)}）`);
    console.log(`   DeepSeek flash      $${(perFl * perMonth).toFixed(0)}（差 $${((perCl - perFl) * perMonth).toFixed(0)}）`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
