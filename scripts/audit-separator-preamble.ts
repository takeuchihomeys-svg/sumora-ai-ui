// scripts/audit-separator-preamble.ts — 2026-10-02 ⑫ 13巡目: 「指示の文＋区切り線」の前置きを落とす出口（meta-narration.stripSeparatorPreamble）を
//   本番のスタッフの送信 365日と AI の下書きに当て、変わる通を目で読む（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-separator-preamble.ts
import { createClient } from "@supabase/supabase-js";
import { stripSeparatorPreamble } from "../app/lib/meta-narration";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
(async () => {
  let n = 0, hit = 0;
  for (let f = 0; f < 600_000; f += 1000) {
    const { data } = await sb.from("messages").select("conversation_id, text, is_aix_generated").eq("sender", "staff").gte("created_at", new Date(Date.now() - 365 * 86_400_000).toISOString()).range(f, f + 999);
    for (const r of (data ?? []) as Array<{ conversation_id: string; text: string | null; is_aix_generated: boolean | null }>) { const t = r.text ?? ""; if (!t) continue; n++; const x = stripSeparatorPreamble(t); if (x.removed.length) { hit++; console.log(`送信 ${r.conversation_id.slice(0, 8)} ${r.is_aix_generated ? "AIX" : "手"} 落とす: ${x.removed[0].slice(0, 90)}`); } }
    if ((data ?? []).length < 1000) break;
  }
  const { data: ex } = await sb.from("ai_reply_examples").select("conversation_id, ai_draft").not("ai_draft", "is", null).gte("created_at", new Date(Date.now() - 365 * 86_400_000).toISOString()).limit(20000);
  let d = 0, dh = 0;
  for (const r of (ex ?? []) as Array<{ conversation_id: string | null; ai_draft: string }>) { d++; const x = stripSeparatorPreamble(r.ai_draft); if (x.removed.length) { dh++; console.log(`下書き ${String(r.conversation_id).slice(0, 8)} 落とす: ${x.removed[0].slice(0, 90)}`); } }
  console.log(`\nスタッフの送信 ${n}・変わる ${hit} ／ AI の下書き ${d}・変わる ${dh}`);
})();
