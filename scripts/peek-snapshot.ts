import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const { data } = await sb.from("ai_reply_examples").select("reply_context_snapshot")
    .not("reply_context_snapshot", "is", null).order("created_at", { ascending: false }).limit(3);
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const s = r.reply_context_snapshot as Record<string, unknown>;
    console.log("keys:", Object.keys(s).join(", "));
    const tp = s.turnPair as Record<string, unknown> | undefined;
    if (tp) console.log("  turnPair keys:", Object.keys(tp).join(", "));
    const bs = s.brainStrategy as Record<string, unknown> | undefined;
    console.log("  brainStrategy:", bs ? JSON.stringify(bs).slice(0, 160) : "なし");
    console.log("---");
  }
}
main().catch(e => { console.error(e); process.exit(1); });
