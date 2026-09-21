// 今日 INSERT した設計知見を一覧する（読み取りのみ）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const since = process.env.SINCE ?? new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data, error } = await sb.from("system_design_thinking")
    .select("title, category, tags, created_at")
    .gte("created_at", since).order("created_at", { ascending: true });
  if (error) { console.log("読めない:", error.message); return; }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  console.log(`=== 直近24時間に入れた設計知見 ${rows.length}件 ===\n`);
  for (const r of rows) {
    console.log(`  [${String(r.created_at).slice(11, 16)}] ${r.title}`);
    console.log(`      ${(r.tags as string[] | null)?.join(" / ") ?? ""}`);
  }
  const { count } = await sb.from("system_design_thinking").select("*", { count: "exact", head: true }).eq("is_current", true);
  console.log(`\n   現行の設計知見は全部で ${count ?? "?"}件`);
}
main().catch((e) => { console.error(e); process.exit(1); });
