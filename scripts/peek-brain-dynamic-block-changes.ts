// ブレインの system[1]（DB 由来: ai_prompt_rules / ai_reply_knowledge / trigger_action_rules / aix_action_attribution）が
// いつ変わっているかを、各テーブルの更新時刻で見る（読み取りのみ・本文は出さない）。
// 目的: llm_usage_logs で「26〜27k 読み＋12k 書き」（＝system[1] だけ書き直し）が出た時刻と突き合わせる
// 実行: npx tsx --env-file=.env.local scripts/peek-brain-dynamic-block-changes.ts [--days=2]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const days = Number(arg("days") ?? "2");
const jst = (s: string) => new Date(new Date(s).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");

async function peek(table: string, cols: string[], filter?: (q: any) => any) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  for (const col of cols) {
    let q: any = sb.from(table).select(`${col}`).gte(col, since).order(col, { ascending: true }).limit(200);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) { console.log(`${table}.${col}: (読めない) ${error.message}`); continue; }
    const times = ((data ?? []) as Record<string, string>[]).map((r) => jst(r[col]));
    console.log(`${table}.${col}: ${times.length}件 ${times.join(", ")}`);
  }
}

async function main() {
  console.log(`=== 直近${days}日で更新された行の時刻（JST・MM-DD HH:MM）===`);
  await peek("ai_prompt_rules", ["updated_at", "created_at"]);
  await peek("ai_reply_knowledge", ["updated_at", "created_at"], (q) => q.eq("category", "principle"));
  await peek("trigger_action_rules", ["updated_at", "created_at"]);
  await peek("aix_action_attribution", ["updated_at", "created_at", "calculated_at"]);
}
main().catch((e) => { console.error(e); process.exit(1); });
