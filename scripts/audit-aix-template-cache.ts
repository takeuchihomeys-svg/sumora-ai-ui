// scripts/audit-aix-template-cache.ts — AIX の文作り（aix_template）のキャッシュを、本番の実物の間隔で「今・1h・並びの固定」に分けて計算する（読み取りのみ）
//
// 2026-10-08 竹内「ブレインのところ更にキャッシュ効けるところはみつかっていないのかな？質重視で」:
//   aix_template は system 2ブロック（①固定の前置き 約35k ②DB 学習資産＝絶対原則・失注・ルール 約50k）。
//   ②の鍵は「絶対原則の同点の並び」の揺れで割れていた（同じ日・入力トークン数が同じなのに鍵が違う）。
//   ここでは ②の中身の代わりに「その行の前置きの合計トークン数（cache_read＋cache_write_5m＋cache_write_1h）」を鍵として使い
//   （並びを固定した後の鍵の近似）、5m／1h × 今の鍵／固定した鍵 の4通りを同じ実物で計算する。今の鍵×5m が実額と一致するかで計算を確かめる。
//   ①の大きさは鍵が違うのに読めた行の cache_read（前置きだけ当たった回）から取る（無ければ --b1= で指定）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-template-cache.ts [--since=2026-09-29T11:00:00Z] [--env=production] [--b1=34713]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const since = arg("since", new Date(Date.now() - 14 * 86400_000).toISOString());
const envName = arg("env", "production");
// Sonnet 5.5（$/1M）: 5分書き 2.5・1h書き 4・読み 0.2（素の入力・出力はどの案でも同じなので比べない）
const W5 = 2.5, W1H = 4, RD = 0.2;

type Row = { created_at: string; sys_key_full: string | null; cache_read: number; cache_write_5m: number; cache_write_1h: number };

async function main() {
  const rows: Row[] = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("llm_usage_logs")
      .select("created_at, sys_key_full, cache_read, cache_write_5m, cache_write_1h")
      .gte("created_at", since).eq("env", envName).eq("action", "aix_template").like("model", "claude%")
      .order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  if (!rows.length) { console.log("行がありません"); return; }
  const tot = (r: Row) => (r.cache_read ?? 0) + (r.cache_write_5m ?? 0) + (r.cache_write_1h ?? 0);
  const partial = rows.find((r) => r.cache_read > 0 && (r.cache_write_5m + r.cache_write_1h) > 20000);
  const b1 = Number(arg("b1", String(partial?.cache_read ?? 34713)));
  const span = (Date.parse(rows[rows.length - 1].created_at) - Date.parse(rows[0].created_at)) / 86400_000;

  const actual = rows.reduce((s, r) => s + r.cache_write_5m * W5 + r.cache_write_1h * W1H + r.cache_read * RD, 0) / 1e6;
  function sim(ttlMin: number, keyOf: (r: Row) => string): number {
    const lastKey = new Map<string, number>(); let lastAny = -Infinity; let usd = 0;
    const W = ttlMin === 60 ? W1H : W5;
    for (const r of rows) {
      const t = Date.parse(r.created_at), k = keyOf(r), size = tot(r);
      const gk = (t - (lastKey.get(k) ?? -Infinity)) / 60000, ga = (t - lastAny) / 60000;
      if (gk < ttlMin) usd += size * RD;
      else if (ga < ttlMin) usd += b1 * RD + Math.max(size - b1, 0) * W;
      else usd += size * W;
      lastKey.set(k, t); lastAny = t;
    }
    return usd / 1e6;
  }
  const keyNow = (r: Row) => r.sys_key_full ?? "";
  const keyFixed = (r: Row) => String(tot(r));
  const keysSameSize = new Map<string, Set<string>>();
  for (const r of rows) { const d = `${r.created_at.slice(0, 10)}:${tot(r)}`; if (!keysSameSize.has(d)) keysSameSize.set(d, new Set()); keysSameSize.get(d)!.add(keyNow(r)); }
  const split = [...keysSameSize.entries()].filter(([, s]) => s.size > 1);

  const m = (usd: number) => `$${usd.toFixed(2)}（30日 $${(usd / span * 30).toFixed(1)}）`;
  console.log(`aix_template ${rows.length}回・${span.toFixed(2)}日・鍵 ${new Set(rows.map(keyNow)).size}種類・前置き①の大きさ ${b1}`);
  console.log(`同じ日・同じトークン数なのに鍵が違う組: ${split.length}（${split.map(([d, s]) => `${d}=${s.size}鍵`).join(" / ")}）`);
  console.log(`実額（書き＋読み）: ${m(actual)}`);
  console.log(`計算 今の鍵×5m（実額と同じになるはず）: ${m(sim(5, keyNow))}`);
  console.log(`計算 固定した鍵×5m: ${m(sim(5, keyFixed))}`);
  console.log(`計算 今の鍵×1h: ${m(sim(60, keyNow))}`);
  console.log(`計算 固定した鍵×1h（10/08 の既定）: ${m(sim(60, keyFixed))}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
