// 費用の計算が画面と合わない差を詰める（読み取りのみ）
//
// 2026-09-21 竹内「昨日なんでこんなにAPI消費したんかな？」
// ・cache_write（総和の列）と cache_write_5m + cache_write_1h がずれていないか
// ・claude-opus-5 を呼んでいるのはどの経路か（画面の Opus5 は $0.12 なのに、こちらの計算は $3.86）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;

async function page(sinceIso: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("llm_usage_logs")
      .select("created_at, route, model, status, error_type, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h, output_tokens, thinking_tokens, max_tokens, env, action, stream, stop_reason")
      .gte("created_at", sinceIso).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const rows = await page(new Date(Date.now() - 10 * 86400_000).toISOString());
  const day = (r: Record<string, unknown>) => String(r.created_at).slice(0, 10);
  const t = rows.filter((r) => day(r) === (process.env.TARGET ?? "2026-09-20"));
  console.log(`=== ${process.env.TARGET ?? "2026-09-20"}(UTC) ${t.length}件 ===\n`);

  const sum = (f: (r: Record<string, unknown>) => number) => t.reduce((a, r) => a + f(r), 0);
  const cw = sum((r) => n(r.cache_write));
  const cw5 = sum((r) => n(r.cache_write_5m));
  const cw1 = sum((r) => n(r.cache_write_1h));
  console.log(`① cache_write 列の突き合わせ`);
  console.log(`   cache_write        ${(cw / 1e6).toFixed(3)}M`);
  console.log(`   cache_write_5m     ${(cw5 / 1e6).toFixed(3)}M`);
  console.log(`   cache_write_1h     ${(cw1 / 1e6).toFixed(3)}M`);
  console.log(`   5m+1h              ${((cw5 + cw1) / 1e6).toFixed(3)}M  → 差 ${((cw - cw5 - cw1) / 1e6).toFixed(3)}M`);
  const mismatch = t.filter((r) => n(r.cache_write) !== n(r.cache_write_5m) + n(r.cache_write_1h));
  console.log(`   行ごとに食い違う ${mismatch.length}件 / ${t.length}件`);
  for (const r of mismatch.slice(0, 5)) console.log(`     ${r.route} ${r.model} write=${n(r.cache_write)} 5m=${n(r.cache_write_5m)} 1h=${n(r.cache_write_1h)}`);

  console.log(`\n② トークンの合計（画面の請求と突き合わせる材料）`);
  for (const m of [...new Set(t.map((r) => String(r.model)))]) {
    const rr = t.filter((r) => String(r.model) === m);
    const unc = rr.reduce((a, r) => a + n(r.input_uncached), 0);
    const rd = rr.reduce((a, r) => a + n(r.cache_read), 0);
    const w5 = rr.reduce((a, r) => a + n(r.cache_write_5m), 0);
    const w1 = rr.reduce((a, r) => a + n(r.cache_write_1h), 0);
    const o = rr.reduce((a, r) => a + n(r.output_tokens), 0);
    const th = rr.reduce((a, r) => a + n(r.thinking_tokens), 0);
    console.log(`   ${m.padEnd(30)} ${String(rr.length).padStart(4)}回  素${(unc / 1e6).toFixed(2)}M 読${(rd / 1e6).toFixed(2)}M 書5m${(w5 / 1e6).toFixed(2)}M 書1h${(w1 / 1e6).toFixed(2)}M 出${(o / 1e3).toFixed(0)}k 思考${(th / 1e3).toFixed(0)}k`);
  }

  console.log(`\n③ claude-opus-5 を呼んでいる経路（画面の Opus5 は $0.12 しかない）`);
  const op = rows.filter((r) => String(r.model) === "claude-opus-5");
  const byR = new Map<string, { c: number; equiv: number; days: Set<string> }>();
  for (const r of op) {
    const k = `${r.route} ${r.action ?? ""} env=${r.env}`;
    const b = byR.get(k) ?? { c: 0, equiv: 0, days: new Set<string>() };
    b.c++; b.days.add(day(r));
    b.equiv += n(r.input_uncached) + n(r.cache_write_5m) * 1.25 + n(r.cache_write_1h) * 2 + n(r.cache_read) * 0.1 + n(r.output_tokens) * 5;
    byR.set(k, b);
  }
  for (const [k, v] of [...byR.entries()].sort((a, b) => b[1].equiv - a[1].equiv)) {
    console.log(`   ${String(v.c).padStart(4)}回  入力換算 ${(v.equiv / 1e6).toFixed(3)}M  日=${[...v.days].sort().join(",")}  ${k}`);
  }

  console.log(`\n④ 経路ごとの入力換算トークン（どこが重いか・単価によらない物差し）`);
  const byRoute = new Map<string, { c: number; equiv: number }>();
  for (const r of t) {
    const k = `${r.model === "claude-haiku-4-5-20251001" ? "[H]" : r.model === "claude-opus-5" ? "[O]" : r.model === "claude-sonnet-5" ? "[S]" : "[?]"} ${r.route}`;
    const b = byRoute.get(k) ?? { c: 0, equiv: 0 };
    b.c++;
    b.equiv += n(r.input_uncached) + n(r.cache_write_5m) * 1.25 + n(r.cache_write_1h) * 2 + n(r.cache_read) * 0.1 + n(r.output_tokens) * 5;
    byRoute.set(k, b);
  }
  for (const [k, v] of [...byRoute.entries()].sort((a, b) => b[1].equiv - a[1].equiv).slice(0, 15)) {
    console.log(`   ${(v.equiv / 1e6).toFixed(3)}M  ${String(v.c).padStart(4)}回  ${k}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
