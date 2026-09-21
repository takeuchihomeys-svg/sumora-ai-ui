// scripts/kb-retire.ts — 設計知見を1件だけ非現行にする（CLAUDE.md「古い知見が上書きされたら is_current=false」）
//
// 2026-09-21 追加: 同じセッション内で知見を書き直したい事が多い（実測が進んで結論が変わる）。
//   消すのではなく非現行にして履歴を残す。書き直した物は kb-insert.ts で入れ直す。
//
// 実行: npx tsx --env-file=.env.local scripts/kb-retire.ts "<タイトル（完全一致）>"
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const title = process.argv[2];
if (!title) { console.error('使い方: npx tsx --env-file=.env.local scripts/kb-retire.ts "<タイトル>"'); process.exit(1); }

async function main() {
  const { data, error } = await sb.from("system_design_thinking")
    .update({ is_current: false }).eq("title", title).eq("is_current", true).select("id, title");
  if (error) { console.error("UPDATE 失敗:", error.message); process.exit(1); }
  const rows = (data ?? []) as Array<{ id: string; title: string }>;
  if (rows.length === 0) { console.error(`現行の知見が見つかりません: ${title}`); process.exit(1); }
  for (const r of rows) console.log(`非現行にしました: ${r.title}（${r.id}）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
