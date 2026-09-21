// 請求画面とツールの記録の「比」を日別に見て、ツールで説明できない分を出す（読み取りのみ）
//
// 2026-09-21 竹内「昨日の消費量おかしい。これはテスト以外考えられない」
//
// 前回は「ツール側の額 vs 画面の額」を直接比べて、単価の推測がずれて話が進まなかった。
// 設計知見「効果は平均ではなく狙った事象で測る」に倣い、**比**で見る:
//   ツールの記録は毎日同じ作り方で出しているので、**画面との比が日によって変わるなら、
//   その日はツール以外の何かが乗っている**。単価が合っていなくても結論は出せる。
//
// 画面の値（Claude Console・UTC・竹内さんのスクショと目視）を CONSOLE に入れて比べる。
// 実行: npx tsx --env-file=.env.local scripts/audit-cost-ratio.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const INPUT_PRICE: Record<string, number> = { "claude-sonnet-5": 3, "claude-haiku-4-5-20251001": 1, "claude-opus-5": 15, "claude-sonnet-4-6": 3 };

/** 画面（Claude Console・UTC）の日別合計。9/20 はツールチップの実数、他はグラフの目視 */
const CONSOLE: Record<string, number> = {
  "2026-09-20": 37.04,   // ツールチップの実数（Sonnet5 33.76 / Haiku 3.14 / Opus5 0.12 / Sonnet4.6 0.02）
  "2026-09-19": 13,      // 目視
  "2026-09-18": 25,      // 目視（ツールチップに隠れ気味）
  "2026-09-17": 25,      // 目視
  "2026-09-16": 29,      // 目視
  "2026-09-15": 30,      // 目視
};

async function page(sinceIso: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("llm_usage_logs")
      .select("created_at, route, model, env, input_uncached, cache_read, cache_write_5m, cache_write_1h, output_tokens")
      .gte("created_at", sinceIso).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const cost = (r: Record<string, unknown>) => {
  const p = INPUT_PRICE[String(r.model)];
  if (!p) return 0;
  return (n(r.input_uncached) + n(r.cache_write_5m) * 1.25 + n(r.cache_write_1h) * 2 + n(r.cache_read) * 0.1 + n(r.output_tokens) * 5) * p / 1e6;
};

async function main() {
  const rows = await page(new Date(Date.now() - 10 * 86400_000).toISOString());
  const day = (r: Record<string, unknown>) => String(r.created_at).slice(0, 10);

  console.log(`=== ツールの記録 と 請求画面 の比（UTC）===`);
  console.log(`   日付        ツール    画面    比(画面/ツール)   local(テスト)の割合`);
  const ratios: Array<{ d: string; ratio: number }> = [];
  for (const d of Object.keys(CONSOLE).sort()) {
    const rr = rows.filter((r) => day(r) === d);
    if (rr.length === 0) continue;
    const tool = rr.reduce((a, r) => a + cost(r), 0);
    const loc = rr.filter((r) => String(r.env) === "local").reduce((a, r) => a + cost(r), 0);
    const ratio = CONSOLE[d] / (tool || 1);
    ratios.push({ d, ratio });
    console.log(`   ${d}  ${`$${tool.toFixed(2)}`.padStart(8)}  ${`$${CONSOLE[d].toFixed(2)}`.padStart(7)}  ${ratio.toFixed(2).padStart(10)}      ${(loc / (tool || 1) * 100).toFixed(1).padStart(5)}%`);
  }
  const base = ratios.filter((r) => r.d !== "2026-09-20");
  const avg = base.length ? base.reduce((a, r) => a + r.ratio, 0) / base.length : 0;
  const t20 = ratios.find((r) => r.d === "2026-09-20");
  console.log(`\n   9/20 以外の平均の比: ${avg.toFixed(2)}`);
  if (t20) {
    console.log(`   9/20 の比           : ${t20.ratio.toFixed(2)}  → 平常の ${(t20.ratio / avg).toFixed(1)}倍`);
    const rr = rows.filter((r) => day(r) === "2026-09-20");
    const tool = rr.reduce((a, r) => a + cost(r), 0);
    console.log(`\n   ツールで説明できる分（平常の比で換算）: $${(tool * avg).toFixed(2)}`);
    console.log(`   画面の額                              : $${CONSOLE["2026-09-20"].toFixed(2)}`);
    console.log(`   ツール以外                            : $${(CONSOLE["2026-09-20"] - tool * avg).toFixed(2)}`);
  }

  console.log(`\n=== 9/20 のテスト（env=local）の中身 ===`);
  const loc = rows.filter((r) => day(r) === "2026-09-20" && String(r.env) === "local");
  const byRoute = new Map<string, { c: number; usd: number }>();
  for (const r of loc) { const k = String(r.route); const b = byRoute.get(k) ?? { c: 0, usd: 0 }; b.c++; b.usd += cost(r); byRoute.set(k, b); }
  console.log(`   ${loc.length}回 / $${loc.reduce((a, r) => a + cost(r), 0).toFixed(2)}`);
  for (const [k, v] of [...byRoute.entries()].sort((a, b) => b[1].usd - a[1].usd)) {
    console.log(`     $${v.usd.toFixed(2).padStart(6)}  ${String(v.c).padStart(4)}回  ${k}`);
  }
  const hours = new Map<number, { c: number; usd: number }>();
  for (const r of loc) { const h = new Date(String(r.created_at)).getUTCHours(); const b = hours.get(h) ?? { c: 0, usd: 0 }; b.c++; b.usd += cost(r); hours.set(h, b); }
  console.log(`   時刻別（UTC / JSTは+9）: ${[...hours.entries()].sort((a, b) => a[0] - b[0]).map(([h, v]) => `${h}時 $${v.usd.toFixed(2)}(${v.c})`).join(" ")}`);

  console.log(`\n=== 記録に残らない呼び出し（スクリプトから直接 api.anthropic.com を叩く物）===`);
  console.log(`   scripts/audit-vision-recommend.ts / audit-vision-swap.ts / verify-deepseek-vision.ts / compare-models.ts`);
  console.log(`   これらは dev サーバーを通らないので llm_usage_logs に1行も残らない。`);
  console.log(`   画像20枚前後・max_tokens 200〜900 の規模なので、1回の実行で $1 に届かない見込み。`);
}
main().catch((e) => { console.error(e); process.exit(1); });
