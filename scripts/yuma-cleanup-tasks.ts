// YUMA に残ったテストの副作用（やること・AIX要対応）を片付ける
// CLAUDE.md「AIX要対応の通知などの副作用は片付ける」
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
async function main() {
  const { data, error } = await sb.from("line_tasks")
    .select("id, task_type, status, created_at").eq("conversation_id", YUMA).eq("status", "pending");
  if (error) { console.log("読めない:", error.message); return; }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  console.log(`=== YUMA の pending なやること ${rows.length}件 ===`);
  for (const r of rows) console.log(`   ${String(r.created_at).slice(0, 16)}  ${r.task_type}`);
  if (rows.length === 0) return;
  if (process.env.APPLY === "1") {
    const { error: e2 } = await sb.from("line_tasks").update({ status: "done" })
      .eq("conversation_id", YUMA).eq("status", "pending");
    console.log(e2 ? `片付け失敗: ${e2.message}` : `${rows.length}件を done にした`);
  } else {
    console.log(`\n   ※ 片付けるには APPLY=1 を付けて実行`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
