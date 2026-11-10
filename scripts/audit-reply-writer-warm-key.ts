// scripts/audit-reply-writer-warm-key.ts — 返信の書き手の温め（REPLY_WRITER_WARM）が本物の鍵と一致する前置きを見つけられるかを、本番の記録で確かめる（読むだけ・LLM なし）
// 2026-11-11 作業員2（C1）。直近 N 回の書き手の Claude の呼び出し（llm_usage_logs・名札 reply_generate_claude_writer）ごとに、
//   llm_warm_prefixes の近い時刻の行の system ブロックから sys_key_full と同じ鍵が作れるかを数える。作れない回は温めても効かない（prefix_not_found）。
// 実行: npx tsx --env-file=<.env.local> scripts/audit-reply-writer-warm-key.ts [--n=10]
import { createClient } from "@supabase/supabase-js";
import { systemFullKey } from "../app/lib/llm-usage-recorder";
import { buildReplyWriterWarmTarget, REPLY_WRITER_REAL_ACTION, REPLY_WRITER_WARM_MODEL, type WarmSystemBlock } from "../app/lib/prefix-warm";

const n = Number((process.argv.find((a) => a.startsWith("--n=")) ?? "--n=10").slice(4)) || 10;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });

async function main() {
  const { data: calls, error } = await sb.from("llm_usage_logs").select("created_at, sys_key_full, cache_read, cache_write_1h")
    .eq("action", REPLY_WRITER_REAL_ACTION).like("model", "claude%").eq("env", "production").lt("status", 400)
    .order("created_at", { ascending: false }).limit(n);
  if (error) throw new Error(error.message);
  let found = 0;
  for (const c of calls ?? []) {
    const at = Date.parse(c.created_at as string);
    const { data: rows, error: e2 } = await sb.from("llm_warm_prefixes").select("hash, system_blocks, last_used_at")
      .eq("model", REPLY_WRITER_WARM_MODEL).not("hash", "like", "brain:%").not("hash", "like", "warm:%").not("hash", "like", "convwarm:%")
      .gte("last_used_at", new Date(at - 15 * 60_000).toISOString()).order("last_used_at", { ascending: true }).limit(4);
    if (e2) throw new Error(e2.message);
    let hit: { blocks: number; chars: number } | null = null;
    for (const r of rows ?? []) {
      const sys = (Array.isArray(r.system_blocks) ? r.system_blocks : []) as WarmSystemBlock[];
      if (systemFullKey(sys) !== c.sys_key_full) continue;
      const t = buildReplyWriterWarmTarget(sys);
      if (t && t.key === c.sys_key_full) { hit = { blocks: sys.length, chars: t.chars }; break; }
    }
    if (hit) found++;
    console.log(`${c.created_at}  key=${String(c.sys_key_full).slice(0, 8)}  read=${c.cache_read} write1h=${c.cache_write_1h}  候補${(rows ?? []).length}行  ${hit ? `一致（system ${hit.blocks}ブロック・${hit.chars}字）` : "一致なし"}`);
  }
  console.log(`\n一致 ${found}/${(calls ?? []).length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
