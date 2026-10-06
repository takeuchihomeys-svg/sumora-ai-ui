// scripts/kb-insert.ts — 設計知見を1件 INSERT する（Supabase MCP が落ちている時の経路）
// 実行: npx tsx --env-file=.env.local scripts/kb-insert.ts <JSONファイル>
//   JSON の形: { title, category, insight, rationale, context, applied_to, tags: string[] }
//   category: architecture | prompt_engineering | data_model | ux | performance | ai_design
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import { embedKbRows } from "../app/lib/design-knowledge-rag-server";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const file = process.argv[2];
if (!file) { console.error("使い方: npx tsx --env-file=.env.local scripts/kb-insert.ts <JSONファイル>"); process.exit(1); }

async function main() {
  // 2026-09-20: 1セッションで複数の知見が出る事が多いので配列も受ける（1件の時は今まで通りオブジェクト）
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> | Array<Record<string, unknown>>;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    for (const k of ["title", "category", "insight", "rationale"]) {
      if (!row[k]) { console.error(`必須の項目がありません: ${k}（${String(row.title ?? "無題")}）`); process.exit(1); }
    }
  }
  const { data, error } = await sb.from("system_design_thinking").insert(rows).select("id");
  if (error) { console.error("INSERT 失敗:", error.message); process.exit(1); }
  for (const row of rows) console.log(`設計知見を INSERT しました: ${row.title}`);
  // 2026-10-06（⑯・RAG）入れたその場で埋め込みを作る（scripts/kb.ts --q の自然文の引き方に載る）。失敗しても INSERT は残る（週の整理が埋める）
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  try {
    const e = await embedKbRows(sb, { dry: false, ids });
    console.log(`  埋め込み: ${e.embedded}行（$${e.usd.toFixed(5)}）`);
  } catch (err) { console.warn("  埋め込みに失敗（週の整理で埋める）:", err instanceof Error ? err.message : err); }
}
main().catch((e) => { console.error(e); process.exit(1); });
