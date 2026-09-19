// scripts/kb.ts — 設計知見を引く（MCP が落ちている時の経路・読み取りのみ）
// 実行: npx tsx --env-file=.env.local scripts/kb.ts --tags=RAG,場面 [--q=語] [--limit=10] [--full]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const tags = arg("tags").split(",").map((s) => s.trim()).filter(Boolean);
const q = arg("q");
const limit = Number(arg("limit", "10"));
const full = process.argv.includes("--full");

async function main() {
  let query = sb.from("system_design_thinking")
    .select("title, insight, rationale, tags, created_at")
    .eq("is_current", true).order("created_at", { ascending: false }).limit(limit);
  if (tags.length) query = query.overlaps("tags", tags);
  if (q) query = query.or(`title.ilike.%${q}%,insight.ilike.%${q}%`);
  const { data, error } = await query;
  if (error) { console.error(error.message); process.exit(1); }
  console.log(`=== 設計知見 ${data?.length ?? 0}件 (tags=${tags.join("/") || "なし"} q=${q || "なし"}) ===`);
  for (const d of data ?? []) {
    console.log(`\n■ ${d.title}`);
    console.log(`  [tags] ${(d.tags as string[] ?? []).join(" / ")}`);
    console.log(`  ${String(d.insight).slice(0, full ? 4000 : 700)}`);
    if (full && d.rationale) console.log(`  --根拠-- ${String(d.rationale).slice(0, 2500)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
