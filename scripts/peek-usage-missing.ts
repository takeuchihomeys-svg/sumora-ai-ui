// llm_usage_logs が取りこぼしていないかを見る（読み取りのみ）
//
// 2026-09-21 竹内「昨日なんでこんなにAPI消費したんかな？」
// 画面（$37.04）とこちらの計算（$20.60）に差がある。設計知見「記録を書いているのが誰かを先に確かめる」に従い、
// ①ストリーミングの回で usage が 0 になっていないか ②トークンが全部0の行がどれだけあるか
// ③1回あたりが極端に重い回はどれか、を見る。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;

async function page(sinceIso: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("llm_usage_logs")
      .select("created_at, route, model, status, stream, stop_reason, input_uncached, cache_read, cache_write_5m, cache_write_1h, output_tokens, max_tokens, env, duration_ms")
      .gte("created_at", sinceIso).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const equiv = (r: Record<string, unknown>) =>
  n(r.input_uncached) + n(r.cache_write_5m) * 1.25 + n(r.cache_write_1h) * 2 + n(r.cache_read) * 0.1 + n(r.output_tokens) * 5;
const tokens = (r: Record<string, unknown>) =>
  n(r.input_uncached) + n(r.cache_write_5m) + n(r.cache_write_1h) + n(r.cache_read) + n(r.output_tokens);

async function main() {
  const target = process.env.TARGET ?? "2026-09-20";
  const rows = await page(new Date(Date.now() - 10 * 86400_000).toISOString());
  const t = rows.filter((r) => String(r.created_at).slice(0, 10) === target);
  console.log(`=== ${target}(UTC) ${t.length}件 ===\n`);

  console.log(`① ストリーミングかどうか（stream=true で usage が取れていないと、その分は記録に出ない）`);
  for (const s of [true, false]) {
    const rr = t.filter((r) => !!r.stream === s);
    const zero = rr.filter((r) => tokens(r) === 0);
    console.log(`   stream=${String(s).padEnd(5)} ${String(rr.length).padStart(4)}回  トークン0の行 ${zero.length}回  入力換算 ${(rr.reduce((a, r) => a + equiv(r), 0) / 1e6).toFixed(2)}M`);
  }

  console.log(`\n② トークンが全部0の行（払っているのに記録が空の疑い）`);
  const zero = t.filter((r) => tokens(r) === 0);
  console.log(`   ${zero.length}回 / ${t.length}回`);
  const zm = new Map<string, number>();
  for (const r of zero) zm.set(`${r.route} stream=${r.stream} status=${r.status}`, (zm.get(`${r.route} stream=${r.stream} status=${r.status}`) ?? 0) + 1);
  for (const [k, c] of [...zm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`     ${String(c).padStart(4)}回  ${k}`);

  console.log(`\n③ 1回が重い上位10（入力換算）`);
  for (const r of [...t].sort((a, b) => equiv(b) - equiv(a)).slice(0, 10)) {
    console.log(`   ${(equiv(r) / 1e6).toFixed(3)}M  ${String(r.created_at).slice(11, 16)}  ${r.model} ${r.route}  素${(n(r.input_uncached) / 1000).toFixed(0)}k 読${(n(r.cache_read) / 1000).toFixed(0)}k 書${((n(r.cache_write_5m) + n(r.cache_write_1h)) / 1000).toFixed(0)}k 出${n(r.output_tokens)}`);
  }

  console.log(`\n④ env 別（本番かローカルか）・日別`);
  const byDayEnv = new Map<string, Map<string, { c: number; e: number }>>();
  for (const r of rows) {
    const d = String(r.created_at).slice(0, 10);
    if (!byDayEnv.has(d)) byDayEnv.set(d, new Map());
    const m = byDayEnv.get(d)!;
    const k = String(r.env ?? "(なし)");
    const b = m.get(k) ?? { c: 0, e: 0 };
    b.c++; b.e += equiv(r); m.set(k, b);
  }
  for (const [d, m] of [...byDayEnv.entries()].sort()) {
    console.log(`   ${d}  ${[...m.entries()].sort((a, b) => b[1].e - a[1].e).map(([k, v]) => `${k} ${(v.e / 1e6).toFixed(2)}M(${v.c}回)`).join(" / ")}`);
  }

  console.log(`\n⑤ 1日の入力換算トークン合計（単価に頼らない物差し）`);
  const byDay = new Map<string, number>();
  for (const r of rows) {
    if (!String(r.model).startsWith("claude-")) continue;
    const d = String(r.created_at).slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + equiv(r));
  }
  for (const [d, v] of [...byDay.entries()].sort()) console.log(`   ${d}  ${(v / 1e6).toFixed(2)}M`);
}
main().catch((e) => { console.error(e); process.exit(1); });
