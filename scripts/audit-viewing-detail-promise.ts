// scripts/audit-viewing-detail-promise.ts
// 2026-10-02 ⑫: 「内覧の詳細については（改めて）ご連絡させて頂きます」は人の実送信 365日で0通。AI の下書きに何通出て、スタッフは代わりに何を送ったかを並べる。
//   出所: ①validate-reply の待ち合わせ確定ゲートの置換文（10/02 に削除へ）②指示文の例（aix-taxonomy の meeting_place の WE DO・line-reply-prompts の例）。読むだけ・LLM なし。
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-detail-promise.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=180").slice(7));
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data, error } = await sb.from("ai_reply_examples").select("conversation_id, ai_draft, sent_reply, was_ai_used, was_ai_modified, created_at").gte("created_at", since).ilike("ai_draft", "%内覧の詳細%").limit(500);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ conversation_id: string | null; ai_draft: string; sent_reply: string | null; was_ai_used: boolean | null; was_ai_modified: boolean | null; created_at: string | null }>;
  const kept = rows.filter((r) => /内覧の詳細/.test(r.sent_reply ?? "")).length;
  console.log(`AI の下書きに「内覧の詳細」${rows.length}通・送った文に残った ${kept}`);
  for (const r of rows.slice(0, 15)) console.log(`  ${String(r.conversation_id ?? "").slice(0, 8)} ${String(r.created_at ?? "").slice(0, 10)}\n    案: ${r.ai_draft.replace(/\n/g, " / ").slice(0, 110)}\n    送: ${(r.sent_reply ?? "").replace(/\n/g, " / ").slice(0, 110)}`);
})();
