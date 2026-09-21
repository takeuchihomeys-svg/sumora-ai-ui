// 別クラウド（DeepSeek）へ回っている経路を見る（読み取りのみ）
// 2026-09-21: Claude Console の Opus5 は $0.12 なのに、こちらの記録は Opus 18回。
//   別クラウドへ回っていれば Anthropic には請求されないので、その分がずれる。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
async function main() {
  const since = new Date(Date.now() - 10 * 86400_000).toISOString();
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("llm_usage_logs")
      .select("created_at, route, model, status, stop_reason, input_uncached, cache_read, cache_write_5m, cache_write_1h, output_tokens, max_tokens, env")
      .gte("created_at", since).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  console.log(`=== ① モデル別の経路（直近10日）===`);
  const m = new Map<string, Map<string, number>>();
  for (const r of out) {
    const k = String(r.model);
    if (!m.has(k)) m.set(k, new Map());
    const mm = m.get(k)!;
    mm.set(String(r.route), (mm.get(String(r.route)) ?? 0) + 1);
  }
  for (const [model, mm] of m) {
    console.log(`\n   ${model}`);
    for (const [route, c] of [...mm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`     ${String(c).padStart(5)}回  ${route}`);
  }

  console.log(`\n=== ② rule-organize の Opus 呼び出し（打ち切られていないか）===`);
  const ro = out.filter((r) => String(r.route).includes("rule-organize"));
  for (const r of ro) {
    console.log(`   ${String(r.created_at).slice(0, 19)}  ${r.model}  stop=${r.stop_reason}  出力${n(r.output_tokens)}/max${n(r.max_tokens)}  入力${n(r.input_uncached)}  status=${r.status}`);
  }

  console.log(`\n=== ③ 出力が max_tokens に当たって切れている回（払って捨てている分）===`);
  const cut = out.filter((r) => String(r.stop_reason) === "max_tokens");
  const byRoute = new Map<string, { c: number; out: number }>();
  for (const r of cut) { const k = `${r.route} ${r.model}`; const b = byRoute.get(k) ?? { c: 0, out: 0 }; b.c++; b.out += n(r.output_tokens); byRoute.set(k, b); }
  console.log(`   ${cut.length}回 / ${out.length}回`);
  for (const [k, v] of [...byRoute.entries()].sort((a, b) => b[1].out - a[1].out).slice(0, 12)) {
    console.log(`     ${String(v.c).padStart(4)}回  出力計 ${(v.out / 1000).toFixed(0)}k  ${k}`);
  }

  console.log(`\n=== ④ stop_reason の分布 ===`);
  const sr = new Map<string, number>();
  for (const r of out) sr.set(String(r.stop_reason), (sr.get(String(r.stop_reason)) ?? 0) + 1);
  for (const [k, c] of [...sr.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(c).padStart(5)}回  ${k}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
