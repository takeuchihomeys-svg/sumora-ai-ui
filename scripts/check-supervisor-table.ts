/**
 * learn_supervisor_log ができたかを確認する（2026-11-14）
 * 実行: npx tsx --env-file=.env.local scripts/check-supervisor-table.ts
 *
 * 竹内さんが Supabase の SQL Editor で SUPERVISOR_LOG.sql を実行した後に使う。
 */
import { supabase as sb } from "../app/lib/supabase-server";

void (async () => {
  const r = await sb.from("learn_supervisor_log").select("id, created_at, scope, verdict, coverage").limit(3);
  if (r.error) {
    const missing = /does not exist|42P01|Could not find the table|schema cache/i.test(String(r.error.message || ""));
    console.log(missing ? "❌ まだテーブルがありません" : "❌ 読めません: " + r.error.message);
    if (missing) {
      console.log("   → Supabase の SQL Editor で SUPERVISOR_LOG.sql を実行してください");
      console.log("   → （実行済みなら、30秒ほど待ってからもう一度）");
    }
    process.exitCode = 1;
    return;
  }
  const rows = (r.data ?? []) as Array<Record<string, unknown>>;
  console.log("✅ テーブルがあります（learn_supervisor_log）");
  console.log(`   いまの行数（先頭3件）: ${rows.length}`);
  for (const x of rows) {
    console.log(`   ${String(x.created_at)} / ${String(x.scope)} / ${String(x.verdict)} / 材料${String(x.coverage)}`);
  }
  if (!rows.length) console.log("   （まだ判断は保存されていません。次の束の作成時に溜まります）");
  // 件数
  const c = await sb.from("learn_supervisor_log").select("*", { count: "exact", head: true });
  if (!c.error) console.log(`   全体の行数: ${c.count ?? 0}`);
})();
