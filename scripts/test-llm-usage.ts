// scripts/test-llm-usage.ts — テストの LLM の使い方を llm_usage_logs で確かめる（読み取りのみ・LLM は呼ばない）
//
// 2026-10-01 竹内「テスト行う際必ずこのやりかた（ブレインのぶぶん）読むようにしたらいける。1～4すべて改善する」（手順書 memory/test_protocol_brain.md）
//   テストの報告に必ず付ける数（model・回数・費用・漏れ・止めた呼び出し・YUMA 以外）を1回で出す。
//   ① env=local*（手元）の行を env × route × action × model で数え、費用（llm-price の単価・DeepSeek は時間帯で倍）を出す
//   ② 漏れ: env=local:deepseek-all で Claude（status<400）に行った行（0 でなければ漏れ）
//   ③ 止めた: error_type=test_blocked の行（テストの歯止めが止めた呼び出し・費用0）
//   ④ YUMA 以外の会話の行（テストでは 0 のはず）
// 実行: npx tsx --env-file=.env.local scripts/test-llm-usage.ts [--since=2026-10-01T08:00:00Z|--hours=3] [--route=script:yuma-xxx] [--rows]
import { createClient } from "@supabase/supabase-js";
import { claudeUsageUsd, altUsageUsd } from "../app/lib/llm-price";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const since = arg("since") ?? new Date(Date.now() - Number(arg("hours") ?? "3") * 3600_000).toISOString();
const route = arg("route");

type Row = { created_at: string; route: string | null; model: string | null; status: number; error_type: string | null; action: string | null; conversation_id: string | null; env: string | null;
  input_uncached: number; cache_read: number; cache_write_5m: number; cache_write_1h: number; cache_write: number; output_tokens: number };

async function main() {
  const rows: Row[] = [];
  for (let p = 0; p < 50; p++) {
    let q = sb.from("llm_usage_logs").select("created_at, route, model, status, error_type, action, conversation_id, env, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens")
      .gte("created_at", since).like("env", "local%").order("created_at").range(p * 1000, p * 1000 + 999);
    if (route) q = q.eq("route", route);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  const isClaude = (r: Row) => /claude/.test(r.model ?? "");
  const usd = (r: Row) => (isClaude(r) ? claudeUsageUsd(r) : altUsageUsd(r));
  console.log(`=== テストの LLM（env=local*・${since} 以降${route ? `・route=${route}` : ""}）: ${rows.length}行 ===`);
  const by = new Map<string, { n: number; usd: number }>();
  for (const r of rows) {
    const k = `${r.env} | ${r.route ?? "-"} | ${r.action ?? "(名札なし)"} | ${r.model}${r.error_type ? ` | ${r.error_type}` : ""}`;
    const v = by.get(k) ?? { n: 0, usd: 0 }; v.n++; v.usd += usd(r); by.set(k, v);
  }
  for (const [k, v] of [...by].sort((a, b) => b[1].usd - a[1].usd)) console.log(`  ${String(v.n).padStart(4)}回 $${v.usd.toFixed(4)}  ${k}`);
  const claude = rows.filter((r) => isClaude(r) && r.status > 0 && r.status < 400);
  const alt = rows.filter((r) => !isClaude(r) && r.error_type !== "test_blocked");
  console.log(`\n費用: Claude ${claude.length}回 $${claude.reduce((s, r) => s + usd(r), 0).toFixed(4)}／DeepSeek・Jev 等 ${alt.length}回 $${alt.reduce((s, r) => s + usd(r), 0).toFixed(4)}`);
  const leaks = claude.filter((r) => r.env?.endsWith(":deepseek-all"));
  console.log(`② 漏れ（deepseek-all で Claude）: ${leaks.length}回 ${leaks.length ? "⛔" : "✓"}`);
  for (const r of leaks.slice(0, 20)) console.log(`    ${r.created_at.slice(0, 19)} ${r.route ?? "-"} ${r.action ?? "(名札なし)"} ${r.model}`);
  const blocked = rows.filter((r) => r.error_type === "test_blocked");
  console.log(`③ テストの歯止めで止めた: ${blocked.length}回`);
  for (const r of blocked.slice(0, 20)) console.log(`    ${r.created_at.slice(0, 19)} ${r.route ?? "-"} ${r.action ?? "(名札なし)"}`);
  const foreign = rows.filter((r) => r.conversation_id && r.conversation_id !== YUMA_CONVERSATION_ID && r.env !== "local");
  console.log(`④ YUMA 以外の会話（テストの env）: ${foreign.length}回 ${foreign.length ? "⛔" : "✓"}`);
  for (const r of foreign.slice(0, 20)) console.log(`    ${r.created_at.slice(0, 19)} ${r.env} ${r.action} ${r.conversation_id}`);
  if (process.argv.includes("--rows")) for (const r of rows) console.log(`  ${r.created_at.slice(11, 19)} ${r.env} ${r.route ?? "-"} ${r.action ?? "-"} ${r.model} st=${r.status} ${r.error_type ?? ""} conv=${String(r.conversation_id ?? "-").slice(0, 8)} $${usd(r).toFixed(4)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
