// scripts/audit-signal-missing.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-signal-missing.ts
//
// 2026-09-20 竹内「ここなら申込になりそうなお客さんだと分析して」:
//   purchase_signal_level が 327会話中 242件（74%）で「なし」。なぜ判定されていないかを調べる。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const APPLIED = ["applying", "application_push", "screening", "closed_won"];

async function main() {
  const convs: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("conversations")
      .select("id, customer_name, status, suggested_aix_meta, brain_analyzed_at, updated_at, last_sender")
      .range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    convs.push(...(data as Array<Record<string, unknown>>));
    if (data.length < 1000) break;
  }
  const meta = (c: Record<string, unknown>) => c.suggested_aix_meta as Record<string, unknown> | null;
  const sig = (c: Record<string, unknown>) => (meta(c)?.purchase_signal_level as string | null) ?? null;

  const missing = convs.filter((c) => !sig(c));
  const has = convs.filter((c) => sig(c));
  console.log(`=== purchase_signal_level: あり ${has.length} / なし ${missing.length} ===\n`);

  const noMeta = missing.filter((c) => !meta(c));
  const metaButNoSig = missing.filter((c) => !!meta(c));
  console.log(`--- 「なし」の内訳 ---`);
  console.log(`  ブレインの判断そのものが無い: ${noMeta.length}件`);
  console.log(`  判断はあるが項目だけ無い:     ${metaButNoSig.length}件`);

  if (metaButNoSig.length) {
    const keys: Record<string, number> = {};
    for (const c of metaButNoSig) for (const k of Object.keys(meta(c) ?? {})) keys[k] = (keys[k] ?? 0) + 1;
    console.log(`\n  判断が持っている項目（上位12）:`);
    Object.entries(keys).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .forEach(([k, v]) => console.log(`    ${k.padEnd(26)} ${v}件 / ${metaButNoSig.length}`));
  }

  const days = (c: Record<string, unknown>) => {
    const t = c.brain_analyzed_at ? Date.parse(String(c.brain_analyzed_at)) : NaN;
    return Number.isFinite(t) ? (Date.now() - t) / 86400_000 : null;
  };
  const bucket = (d: number | null) => d === null ? "分析なし" : d <= 1 ? "1日以内" : d <= 7 ? "7日以内" : d <= 30 ? "30日以内" : "30日超";
  console.log(`\n--- ブレインが最後に動いた時期 ---`);
  console.log(`  ${"時期".padEnd(10)} ${"あり".padStart(6)} ${"なし".padStart(6)}`);
  for (const b of ["1日以内", "7日以内", "30日以内", "30日超", "分析なし"]) {
    const h = has.filter((c) => bucket(days(c)) === b).length;
    const m = missing.filter((c) => bucket(days(c)) === b).length;
    if (h + m === 0) continue;
    console.log(`  ${b.padEnd(10)} ${String(h).padStart(6)} ${String(m).padStart(6)}`);
  }

  const missedApplied = missing.filter((c) => APPLIED.includes(String(c.status ?? "")));
  console.log(`\n--- 項目が無いまま申込以降に到達: ${missedApplied.length}件（見逃し）---`);
  missedApplied.slice(0, 8).forEach((c) => {
    console.log(`  ${String(c.customer_name).padEnd(14)} status=${c.status} 判断=${meta(c) ? "あり" : "なし"} brain=${String(c.brain_analyzed_at ?? "-").slice(0, 10)}`);
  });

  const alive = convs.filter((c) => { const t = Date.parse(String(c.updated_at ?? "")); return Number.isFinite(t) && Date.now() - t <= 7 * 86400_000; });
  const aliveHas = alive.filter((c) => sig(c)).length;
  console.log(`\n--- 直近7日に動いた会話 ${alive.length}件 ---`);
  console.log(`  購買シグナルあり: ${aliveHas}件（${((100 * aliveHas) / Math.max(alive.length, 1)).toFixed(0)}%）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
