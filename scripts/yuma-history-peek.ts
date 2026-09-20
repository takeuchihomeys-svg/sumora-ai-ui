// YUMA の直近履歴を読む（読み取りのみ）。テストの場面が履歴に負けていないか見るため。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
async function main() {
  const { data } = await sb.from("messages").select("sender, text, created_at, is_aix_generated")
    .eq("conversation_id", YUMA).order("created_at", { ascending: true }).limit(200);
  const all = (data ?? []) as Array<Record<string, unknown>>;
  console.log(`=== YUMA 全 ${all.length}通・直近25通 ===`);
  for (const m of all.slice(-25)) {
    console.log(`[${String(m.created_at).slice(0, 16)}] ${String(m.sender).padEnd(8)} ${String(m.text ?? "").replace(/\n/g, " ／ ").slice(0, 130)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
