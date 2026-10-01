// scripts/audit-cache-ttl-reuse.ts — 経路ごとに「キャッシュの書き込みが読まれる前に切れていないか」を実物の間隔で測る（読み取りのみ）
//
// 2026-10-01 竹内「1～4すべて改善する。設計知見と協力して改善する」（④ 本番のキャッシュ）:
//   本番の Sonnet 5.5 で aix_template（4回で書き込み 256k・読み 1）・brain_strategy（14回中 5回だけ命中）・brain_checkpoint（11回中 5回）が弱かった。
//   設計知見「TTL はそのブロックの鍵を共有する呼び出しの間隔で決める」「キャッシュの損得は短い期間で判断しない（最低1週間）」に従い、
//   同じ鍵（sys_key_full × model）の呼び出しの間隔から、今の費用・キャッシュ無し・5分・1時間 の費用を同じ実物で計算して並べる。
//   ⚠ 前置き（キャッシュに載る分）の大きさは各行の cache_read + cache_write で数える（書きも読みも 0 の行は前置きが最低長未満＝計算に入れない）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-cache-ttl-reuse.ts [--days=7] [--actions=aix_template,brain_strategy,brain_checkpoint] [--env=production]
import { createClient } from "@supabase/supabase-js";
import { claudePriceOf, claudeUsageUsd } from "../app/lib/llm-price";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const days = Number(arg("days", "7"));
const actions = arg("actions", "aix_template,brain_strategy,brain_checkpoint").split(",").map((s) => s.trim()).filter(Boolean);
const envName = arg("env", "production");
const n = (v: unknown) => Number(v ?? 0) || 0;

type Row = { created_at: string; action: string; model: string; sys_key_full: string | null; input_uncached: number; cache_read: number; cache_write_5m: number; cache_write_1h: number; cache_write: number; output_tokens: number; status: number };

async function load(): Promise<Row[]> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const out: Row[] = [];
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb.from("llm_usage_logs")
      .select("created_at, action, model, sys_key_full, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens, status")
      .gte("created_at", since).eq("env", envName).in("action", actions).like("model", "claude%")
      .order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  return out.filter((r) => r.status < 400);
}

/** 同じ鍵の呼び出しを、TTL を ttlMin 分とした時の費用で数え直す（読みは TTL を延ばす＝最後に触った時刻から数える） */
function simulate(rows: Row[], ttlMin: number | null): number {
  let usd = 0;
  const lastTouch = new Map<string, number>();
  for (const r of rows) {
    const price = claudePriceOf(r.model);
    if (!price) continue;
    const prefix = n(r.cache_read) + n(r.cache_write_5m) + n(r.cache_write_1h) + Math.max(n(r.cache_write) - n(r.cache_write_5m) - n(r.cache_write_1h), 0);
    const rest = n(r.input_uncached);
    const out = n(r.output_tokens) * price.out;
    const key = `${r.model}|${r.sys_key_full ?? "-"}`;
    const t = Date.parse(r.created_at);
    if (ttlMin == null || prefix === 0) { usd += ((prefix + rest) * price.in + out) / 1e6; continue; }
    const last = lastTouch.get(key);
    const hit = last != null && t - last <= ttlMin * 60_000;
    const writeRate = ttlMin > 5 ? price.write1h : price.write5m;
    usd += ((hit ? prefix * price.read : prefix * writeRate) + rest * price.in + out) / 1e6;
    lastTouch.set(key, t);
  }
  return usd;
}

async function main() {
  const rows = await load();
  const first = rows[0]?.created_at, last = rows[rows.length - 1]?.created_at;
  const spanDays = first && last ? Math.max(1, (Date.parse(last) - Date.parse(first)) / 86400_000) : days;
  console.log(`=== キャッシュの再利用（env=${envName}・${days}日・実データ ${first?.slice(0, 16) ?? "-"}〜${last?.slice(0, 16) ?? "-"}＝${spanDays.toFixed(1)}日分） ===`);
  for (const a of actions) {
    const rs = rows.filter((r) => r.action === a);
    if (rs.length === 0) { console.log(`\n■ ${a}: 0件`); continue; }
    const keys = new Set(rs.map((r) => `${r.model}|${r.sys_key_full}`));
    const gaps: number[] = [];
    const lastByKey = new Map<string, number>();
    for (const r of rs) {
      const k = `${r.model}|${r.sys_key_full}`; const t = Date.parse(r.created_at);
      const l = lastByKey.get(k); if (l != null) gaps.push((t - l) / 60_000); lastByKey.set(k, t);
    }
    const bucket = (lo: number, hi: number) => gaps.filter((g) => g >= lo && g < hi).length;
    const sum = (f: (r: Row) => number) => rs.reduce((s, r) => s + f(r), 0);
    const hits = rs.filter((r) => n(r.cache_read) > 0).length;
    const actual = sum((r) => claudeUsageUsd(r));
    const none = simulate(rs, null), m5 = simulate(rs, 5), h1 = simulate(rs, 60);
    const perDay = (x: number) => (x / spanDays).toFixed(3);
    console.log(`\n■ ${a}: ${rs.length}回（鍵 ${keys.size}種類）命中 ${hits}/${rs.length}・読み ${(sum((r) => n(r.cache_read)) / 1000).toFixed(0)}k・書き5m ${(sum((r) => n(r.cache_write_5m)) / 1000).toFixed(0)}k・書き1h ${(sum((r) => n(r.cache_write_1h)) / 1000).toFixed(0)}k・前置き無し入力 ${(sum((r) => n(r.input_uncached)) / 1000).toFixed(0)}k`);
    console.log(`  同じ鍵の間隔: 5分未満 ${bucket(0, 5)}／5〜60分 ${bucket(5, 60)}／60分以上 ${bucket(60, 1e9)}（中央値 ${gaps.length ? [...gaps].sort((x, y) => x - y)[Math.floor(gaps.length / 2)].toFixed(0) : "-"}分）`);
    console.log(`  費用（期間合計→1日あたり）: 今 $${actual.toFixed(3)}→$${perDay(actual)}／キャッシュ無し $${none.toFixed(3)}→$${perDay(none)}／5分 $${m5.toFixed(3)}→$${perDay(m5)}／1時間 $${h1.toFixed(3)}→$${perDay(h1)}`);
    if (process.argv.includes("--rows")) for (const r of rs) console.log(`    ${r.created_at.slice(5, 16)} ${r.model} key=${r.sys_key_full} read=${r.cache_read} w5=${r.cache_write_5m} w1h=${r.cache_write_1h} in=${r.input_uncached} out=${r.output_tokens}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
