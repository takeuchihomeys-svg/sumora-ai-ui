// ブレイン（Claude）の1日の費用の形を見る（読み取りのみ・お客様名は出さない）
// 実行: npx tsx --env-file=.env.local scripts/peek-brain-cost-day.ts [--days=1]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const days = Number(arg("days") ?? "1");
const PRICE: Record<string, [number, number, number, number, number]> = { haiku: [1, 0.1, 1.25, 2, 5], sonnet: [3, 0.3, 3.75, 6, 15], opus: [5, 0.5, 6.25, 10, 25], deepseek: [0.28, 0.028, 0, 0, 0.42] };
type Row = { created_at: string; route: string | null; action: string | null; model: string | null; status: number | null; input_uncached: number; cache_read: number; cache_write_5m: number; cache_write_1h: number; cache_write: number; output_tokens: number; thinking_tokens: number; conversation_id: string | null };
function tier(m: string | null) { const s = (m ?? "").toLowerCase(); return s.includes("haiku") ? "haiku" : s.includes("opus") ? "opus" : s.includes("deepseek") ? "deepseek" : "sonnet"; }
function usd(r: Row): number {
  const p = PRICE[tier(r.model)];
  const w5 = r.cache_write_5m || (r.cache_write_1h ? 0 : r.cache_write) || 0;
  return (r.input_uncached * p[0] + r.cache_read * p[1] + w5 * p[2] + (r.cache_write_1h || 0) * p[3] + (r.output_tokens + (r.thinking_tokens || 0)) * p[4]) / 1e6;
}
const jst = (s: string) => new Date(new Date(s).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");

async function main() {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  // PostgREST は1回 1000 行まで → range で全部読む
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("llm_usage_logs").select("created_at, route, action, model, status, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens, thinking_tokens, conversation_id").gte("created_at", since).order("created_at", { ascending: true }).range(from, from + 999);
    if (error) { console.log(error.message); process.exit(1); }
    const chunk = (data ?? []) as Row[];
    rows.push(...chunk);
    if (chunk.length < 1000) break;
  }
  const claude = rows.filter((r) => tier(r.model) !== "deepseek");
  const total = claude.reduce((a, r) => a + usd(r), 0);
  console.log(`=== ${days}日分: 全 ${rows.length}行 / Claude ${claude.length}行 $${total.toFixed(2)}（DeepSeek は別） ===`);

  // action ごと
  const byA = new Map<string, { n: number; usd: number; cold: number; coldUsd: number; w1h: number }>();
  for (const r of claude) {
    const k = `${(r.route ?? "").replace("/api/", "")}/${r.action ?? "-"}`;
    const a = byA.get(k) ?? { n: 0, usd: 0, cold: 0, coldUsd: 0, w1h: 0 };
    a.n++; a.usd += usd(r);
    if (r.cache_write_1h > 0) { a.cold++; a.coldUsd += (r.cache_write_1h * (PRICE[tier(r.model)][3] - PRICE[tier(r.model)][1])) / 1e6; a.w1h += r.cache_write_1h; }
    byA.set(k, a);
  }
  console.log("\n=== 経路ごと（cold＝1時間キャッシュを書いた回・coldUsd＝読みで済んだ場合との差） ===");
  for (const [k, a] of [...byA.entries()].sort((x, y) => y[1].usd - x[1].usd).slice(0, 15)) console.log(`${k}: ${a.n}回 $${a.usd.toFixed(2)} cold ${a.cold}回（差 $${a.coldUsd.toFixed(2)}）`);

  // ブレインの cold の時刻分布と、prefix の大きさ（会話ごとに違えば会話別キャッシュ）
  // 2026-09-24: 温め（action='brain-warm'）は本物（brain_*）に混ぜない（温めの cold を「ブレインの全冷え」に数えると効果判定が壊れる）
  const brain = claude.filter((r) => (r.action ?? "").startsWith("brain_"));
  const cold = brain.filter((r) => r.cache_write_1h > 0);
  console.log(`\n=== ブレイン ${brain.length}回 $${brain.reduce((a, r) => a + usd(r), 0).toFixed(2)}・cold ${cold.length}回（brain-warm は別・下に出す） ===`);
  const warm = claude.filter((r) => r.action === "brain-warm");
  const warmKind = (r: Row) => (r.cache_write_1h === 0 && r.cache_read > 0 ? "hit" : r.cache_write_1h > 0 && r.cache_read >= 20_000 ? "dynamic_rewrite" : r.cache_write_1h > 0 ? "cold" : "no_cache");
  const warmByKind = new Map<string, { n: number; usd: number }>();
  for (const r of warm) { const k = warmKind(r); const a = warmByKind.get(k) ?? { n: 0, usd: 0 }; a.n++; a.usd += usd(r); warmByKind.set(k, a); }
  console.log(`=== 温め（brain-warm）${warm.length}回 $${warm.reduce((a, r) => a + usd(r), 0).toFixed(2)}: ` + (warm.length ? [...warmByKind.entries()].map(([k, a]) => `${k} ${a.n}回 $${a.usd.toFixed(2)}`).join(" / ") : "なし") + " ===");
  const sizes = new Map<number, number>();
  for (const r of brain) { const s = r.cache_read || r.cache_write_1h; sizes.set(Math.round(s / 1000), (sizes.get(Math.round(s / 1000)) ?? 0) + 1); }
  console.log("prefix の大きさ(千トークン)の分布:", [...sizes.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}k×${v}`).join(" "));
  console.log("cold の時刻:", cold.map((r) => `${jst(r.created_at)}(${r.conversation_id?.slice(0, 6) ?? "-"})`).join(", "));

  // 会話ごとの費用 top 8（Claude のみ）
  const per = new Map<string, { usd: number; n: number; brain: number; acts: Map<string, number> }>();
  for (const r of claude) {
    const k = r.conversation_id ?? "(なし)";
    const p = per.get(k) ?? { usd: 0, n: 0, brain: 0, acts: new Map() };
    p.usd += usd(r); p.n++; if ((r.action ?? "").startsWith("brain_")) p.brain++;
    p.acts.set(r.action ?? "-", (p.acts.get(r.action ?? "-") ?? 0) + 1);
    per.set(k, p);
  }
  console.log("\n=== 会話ごと top 8（Claude） ===");
  for (const [k, p] of [...per.entries()].sort((x, y) => y[1].usd - x[1].usd).slice(0, 8)) {
    console.log(`${k.slice(0, 8)}: $${p.usd.toFixed(2)} ${p.n}回（ブレイン ${p.brain}）` + " " + [...p.acts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, n]) => `${a}×${n}`).join(" "));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
