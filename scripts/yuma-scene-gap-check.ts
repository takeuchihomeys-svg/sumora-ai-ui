// yuma-scene-gap-s3.ts の後始末の確認（読み取りのみ）: YUMA に残り物が無いか・費用はいくらか
// 実行: npx tsx --env-file=.env.local scripts/yuma-scene-gap-check.ts SINCE=2026-09-23T06:37:00Z
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
async function main() {
  const since = process.env.SINCE ?? "2026-09-23T06:37:00Z";
  const { data: conv } = await sb.from("conversations").select("status, ai_draft, brain_analyzed_at, last_sender, suggested_aix_meta, property_customer_id").eq("id", YUMA).maybeSingle();
  const c = (conv ?? {}) as Record<string, unknown>;
  console.log(`YUMA: status=${c.status} ai_draft=${String(c.ai_draft ?? "null").slice(0, 30)} brain_analyzed_at=${c.brain_analyzed_at} last_sender=${c.last_sender} meta.action=${(c.suggested_aix_meta as Record<string, unknown> | null)?.action}`);
  const { count: mc } = await sb.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", YUMA).gte("created_at", since);
  const { count: mc2 } = await sb.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", YUMA).gte("created_at", "2026-09-22T12:00:00Z");
  const { count: ai } = await sb.from("aix_action_items").select("id", { count: "exact", head: true }).eq("conversation_id", YUMA).gte("created_at", since);
  const pc = c.property_customer_id as string | null;
  const { data: cmds } = pc ? await sb.from("automation_commands").select("id, status, payload").contains("customer_ids", [pc]).gte("created_at", since) : { data: [] };
  const { count: tasks } = await sb.from("line_tasks").select("id", { count: "exact", head: true }).eq("conversation_id", YUMA).gte("created_at", since);
  console.log(`残り物: messages(since)=${mc} messages(9/22 21:00 JST 以降)=${mc2} aix_action_items=${ai} automation_commands=${(cmds ?? []).length} line_tasks=${tasks ?? "?"}`);
  // 費用
  const { data: logs } = await sb.from("llm_usage_logs").select("route, model, env, conversation_id, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h, output_tokens, status").gte("created_at", since).order("created_at").limit(2000);
  const rows = ((logs ?? []) as Array<Record<string, unknown>>).filter((r) => r.env !== "production" || r.conversation_id === YUMA);
  const price: Record<string, [number, number, number, number]> = { "claude-sonnet-5": [3, 0.3, 3.75, 6], "claude-sonnet-4-5": [3, 0.3, 3.75, 6], "claude-haiku-4-5": [1, 0.1, 1.25, 2], "claude-opus-4-1": [15, 1.5, 18.75, 30] };
  let usd = 0; const byRoute = new Map<string, { n: number; usd: number }>();
  for (const r of rows) {
    const p = price[String(r.model)] ?? [3, 0.3, 3.75, 6];
    const u = (Number(r.input_uncached ?? 0) * p[0] + Number(r.cache_read ?? 0) * p[1] + Number(r.cache_write_5m ?? 0) * p[2] + Number(r.cache_write_1h ?? 0) * p[3] + Number(r.output_tokens ?? 0) * p[0] * 5) / 1e6;
    usd += u; const k = `${r.route} ${r.model}`; const b = byRoute.get(k) ?? { n: 0, usd: 0 }; b.n++; b.usd += u; byRoute.set(k, b);
  }
  console.log(`費用（${since} 以降・dev または YUMA）: ${rows.length}回 ≈ $${usd.toFixed(3)}`);
  for (const [k, v] of [...byRoute].sort((a, b) => b[1].usd - a[1].usd)) console.log(`   ${String(v.n).padStart(3)}回 $${v.usd.toFixed(3)}  ${k}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
