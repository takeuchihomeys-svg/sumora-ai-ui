// LLM に材料（会話履歴・手本・ブレインの判断）が届いていなかった生成を、本番の使用記録から探す（読み取りのみ）
// 2026-09-22 竹内（みなみさん事例）「また申込ととってしまっている。LLM が原因の可能性が高い。原因を見つけて調査する」
//   原因: 伏せ字処理（pii-pseudonym）が材料の塊ごと「[お申込み情報を受け取りました]」の1行に差し替えていた（maskBlock で直した）。
//   印: 動的部分（キャッシュに無い入力）が数十トークンしか無く、別々の会話なのにキャッシュ読みが同じ数字になる。
// 実行: npx tsx --env-file=.env.local scripts/audit-llm-context-dropped.ts [SINCE=2026-09-19]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const since = process.env.SINCE ?? "2026-09-19";
  const { data } = await sb.from("llm_usage_logs").select("created_at, route, model, input_uncached, cache_read, conversation_id")
    .in("route", ["/api/generate-reply", "/api/aix/action"]).gte("created_at", `${since}T00:00:00Z`).lt("input_uncached", 60).gt("cache_read", 0).order("created_at");
  const rows = ((data ?? []) as Array<{ created_at: string; route: string; model: string; input_uncached: number; cache_read: number; conversation_id: string | null }>)
    .filter((r) => /deepseek-v4-pro|sonnet|opus/.test(r.model));
  console.log(`${since} 以降・動的部分が60トークン未満の主生成: ${rows.length}回（同じ材料で作り直した回も含む）`);
  for (const r of rows) {
    let draft = "";
    if (r.route === "/api/generate-reply" && r.conversation_id) {
      const t = new Date(r.created_at).getTime();
      const { data: ex } = await sb.from("ai_reply_examples").select("customer_message, ai_draft").eq("conversation_id", r.conversation_id)
        .gte("created_at", new Date(t - 60_000).toISOString()).order("created_at").limit(1);
      const e = (ex ?? [])[0] as { customer_message?: string; ai_draft?: string } | undefined;
      if (e) draft = `客「${String(e.customer_message ?? "").replace(/\s+/g, " ").slice(0, 36)}」→ AI「${String(e.ai_draft ?? "").replace(/\s+/g, " ").slice(0, 70)}」`;
    }
    console.log(`  ${r.created_at.slice(5, 19)} ${r.route.replace("/api/", "")} ${r.model} 動的=${r.input_uncached} キャッシュ読み=${r.cache_read} 会話=${(r.conversation_id ?? "").slice(0, 8)} ${draft}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
