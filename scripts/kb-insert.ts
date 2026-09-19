// scripts/kb-insert.ts — 設計知見を1件 INSERT する（Supabase MCP が落ちている時の経路）
// 実行: npx tsx --env-file=.env.local scripts/kb-insert.ts <JSONファイル>
//   JSON の形: { title, category, insight, rationale, context, applied_to, tags: string[] }
//   category: architecture | prompt_engineering | data_model | ux | performance | ai_design
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const file = process.argv[2];
if (!file) { console.error("使い方: npx tsx --env-file=.env.local scripts/kb-insert.ts <JSONファイル>"); process.exit(1); }

async function main() {
  const row = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  for (const k of ["title", "category", "insight", "rationale"]) {
    if (!row[k]) { console.error(`必須の項目がありません: ${k}`); process.exit(1); }
  }
  const { error } = await sb.from("system_design_thinking").insert(row);
  if (error) { console.error("INSERT 失敗:", error.message); process.exit(1); }
  console.log(`設計知見を INSERT しました: ${row.title}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
