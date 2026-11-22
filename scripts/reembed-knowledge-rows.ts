// scripts/reembed-knowledge-rows.ts — 中身を直した ai_reply_knowledge の行の埋め込みを作り直す（その行だけ・埋め込み N 回）
// 2026-11-21 作業員L（owner_questions 65bb056b の直しで中身を書き換えた行）。embedding_h はトリガーが埋める。
// 実行: npx tsx --env-file=.env.local scripts/reembed-knowledge-rows.ts <id> [<id> ...]
import { createClient } from "@supabase/supabase-js";
import { generateEmbedding } from "../app/lib/knowledge-utils";
(async () => {
  const ids = process.argv.slice(2).filter((x) => /^[0-9a-f-]{36}$/.test(x));
  if (!ids.length) throw new Error("id を渡す");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const { data, error } = await sb.from("ai_reply_knowledge").select("id, content").in("id", ids);
  if (error) throw new Error(error.message);
  for (const r of (data ?? []) as Array<{ id: string; content: string }>) {
    const emb = await generateEmbedding(r.content);
    if (!emb) { console.log(`${r.id.slice(0, 8)} 埋め込みが作れない`); continue; }
    const { error: e2 } = await sb.from("ai_reply_knowledge").update({ embedding: JSON.stringify(emb) }).eq("id", r.id);
    console.log(`${r.id.slice(0, 8)} ${e2 ? `失敗 ${e2.message}` : "作り直した"}`);
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
