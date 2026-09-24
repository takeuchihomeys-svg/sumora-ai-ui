// ブレイン（action=brain*）の前置きの変種を llm_usage_logs で数える（読み取りのみ・本文もお客様名も出さない）
// 目的: 温め（brain-warm）の設計材料。「同じ鍵（model・system・thinking）で毎回読めているか」「26〜27k の変種は何か」を事実で見る
// 実行: npx tsx --env-file=.env.local scripts/peek-brain-prefix-variants.ts [--days=2]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const days = Number(arg("days") ?? "2");
type Row = { created_at: string; route: string | null; action: string | null; model: string | null; env: string | null; status: number | null; input_uncached: number; cache_read: number; cache_write_5m: number; cache_write_1h: number; cache_write: number; output_tokens: number; max_tokens: number | null; thinking_mode: string | null; cache_breakpoints: number; sys_key: string | null; sys_key_full: string | null; conversation_id: string | null };
const jst = (s: string) => new Date(new Date(s).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
const k = (n: number) => `${Math.round(n / 1000)}k`;

async function main() {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("llm_usage_logs")
      .select("created_at, route, action, model, env, status, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens, max_tokens, thinking_mode, cache_breakpoints, sys_key, sys_key_full, conversation_id")
      .gte("created_at", since).like("action", "brain%").order("created_at", { ascending: true }).range(from, from + 999);
    if (error) { console.log(error.message); process.exit(1); }
    const chunk = (data ?? []) as Row[];
    rows.push(...chunk);
    if (chunk.length < 1000) break;
  }
  console.log(`=== ${days}日分: brain* ${rows.length}行 ===`);

  // 1) 鍵に入る物ごと（model / env / thinking / breakpoints / sys_key / sys_key_full）
  const byKey = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.action} | ${r.model} | env=${r.env} | thinking=${r.thinking_mode} | bp=${r.cache_breakpoints} | max_tokens=${r.max_tokens} | sys_key=${r.sys_key} | sys_full=${r.sys_key_full} | status=${r.status}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  console.log("\n=== 鍵の組み合わせ（action | model | env | thinking | cache_control数 | max_tokens | sys_key | sys_key_full | status）===");
  for (const [key, n] of [...byKey.entries()].sort((a, b) => b[1] - a[1])) console.log(`${n}回  ${key}`);

  // 2) 読み・書きの形（cache_read と cache_write_1h の千トークン）ごと
  const byShape = new Map<string, { n: number; ex: string[] }>();
  for (const r of rows) {
    const key = `${r.action} | read=${k(r.cache_read)} | write1h=${k(r.cache_write_1h)} | write5m=${k(r.cache_write_5m)} | uncached=${k(r.input_uncached)} | env=${r.env} | sys_full=${r.sys_key_full}`;
    const s = byShape.get(key) ?? { n: 0, ex: [] };
    s.n++; if (s.ex.length < 3) s.ex.push(jst(r.created_at));
    byShape.set(key, s);
  }
  console.log("\n=== 読み・書きの形（read=読めた分・write1h=1時間キャッシュに書いた分・uncached=割引なし）===");
  for (const [key, s] of [...byShape.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`${s.n}回  ${key}  例: ${s.ex.join(", ")}`);

  // 3) 26〜27k・40k超 の行を個別に（何が違うか）
  console.log("\n=== read+write1h が 30k 未満、または 40k 超の行 ===");
  for (const r of rows) {
    const tot = r.cache_read + r.cache_write_1h;
    if (tot < 30_000 || tot > 40_000) console.log(`${jst(r.created_at)} ${r.action} env=${r.env} read=${r.cache_read} w1h=${r.cache_write_1h} w5m=${r.cache_write_5m} uncached=${r.input_uncached} bp=${r.cache_breakpoints} sys_full=${r.sys_key_full} conv=${r.conversation_id?.slice(0, 6) ?? "-"}`);
  }

  // 4) 本番の最後の呼び出しと、呼び出しの間隔が 60 分を超えた回（冷えた回）
  const prod = rows.filter((r) => r.env === "production" && (r.status ?? 0) < 400);
  console.log(`\n=== 本番（env=production・成功）${prod.length}行・最後: ${prod.length ? jst(prod[prod.length - 1].created_at) : "-"} ===`);
  let prev: Row | null = null;
  for (const r of prod) {
    if (prev) {
      const gapMin = (new Date(r.created_at).getTime() - new Date(prev.created_at).getTime()) / 60_000;
      if (gapMin >= 50) console.log(`間隔 ${gapMin.toFixed(0)}分 → ${jst(r.created_at)} ${r.action} read=${k(r.cache_read)} w1h=${k(r.cache_write_1h)}`);
    }
    prev = r;
  }
  // 5) env の内訳
  const byEnv = new Map<string, number>();
  for (const r of rows) byEnv.set(r.env ?? "(null)", (byEnv.get(r.env ?? "(null)") ?? 0) + 1);
  console.log("\n=== env の内訳 ===", [...byEnv.entries()].map(([e, n]) => `${e}:${n}`).join(" "));
}
main().catch((e) => { console.error(e); process.exit(1); });
