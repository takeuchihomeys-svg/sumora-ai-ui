// generate-reply の本体プロンプトで Sonnet が呼ばれた行（DeepSeek に回っていない生成）の時刻と会話を見る（読み取りのみ）
// 実行: npx tsx --env-file=.env.local scripts/peek-sonnet-generate-calls.ts [--days=1]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const days = Number(arg("days") ?? "1");
const jst = (s: string) => new Date(new Date(s).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
async function main() {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await sb.from("llm_usage_logs").select("created_at, route, action, model, conversation_id, input_uncached, cache_read, output_tokens, stop_reason, env, request_id")
    .gte("created_at", since).ilike("model", "%sonnet%").ilike("sys_head", "【指示の優先順位%").order("created_at", { ascending: true }).limit(1000);
  if (error) { console.log(error.message); process.exit(1); }
  const rows = data ?? [];
  console.log(`=== Sonnet × 生成本体プロンプト: ${rows.length}行 ===`);
  const byConv = new Map<string, number>(); const byHour = new Map<string, number>(); const byRoute = new Map<string, number>(); const byEnv = new Map<string, number>();
  for (const r of rows as Array<Record<string, unknown>>) {
    byConv.set(String(r.conversation_id ?? "(なし)").slice(0, 8), (byConv.get(String(r.conversation_id ?? "(なし)").slice(0, 8)) ?? 0) + 1);
    byHour.set(jst(String(r.created_at)).slice(0, 11), (byHour.get(jst(String(r.created_at)).slice(0, 11)) ?? 0) + 1);
    byRoute.set(`${r.route}|${r.action ?? "-"}`, (byRoute.get(`${r.route}|${r.action ?? "-"}`) ?? 0) + 1);
    byEnv.set(String(r.env ?? "-"), (byEnv.get(String(r.env ?? "-")) ?? 0) + 1);
  }
  console.log("会話:", [...byConv.entries()].map(([k, v]) => `${k}×${v}`).join(" "));
  console.log("時間帯(JST):", [...byHour.entries()].map(([k, v]) => `${k}時×${v}`).join(" "));
  console.log("route|action:", [...byRoute.entries()].map(([k, v]) => `${k}×${v}`).join(" "));
  console.log("env:", [...byEnv.entries()].map(([k, v]) => `${k}×${v}`).join(" "));
  console.log("\n先頭10行:");
  for (const r of (rows as Array<Record<string, unknown>>).slice(0, 10)) console.log(`${jst(String(r.created_at))} ${r.route} ${r.action ?? "-"} conv=${String(r.conversation_id ?? "-").slice(0, 8)} in=${r.input_uncached} read=${r.cache_read} out=${r.output_tokens} stop=${r.stop_reason} env=${r.env}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
