// scripts/audit-rent-question-1007.ts — 2026-10-07 返信の質の1巡目: 相場の質問の見分け（rent-question.customerAsksRentLevel）に足した形の線（読むだけ・LLM なし）
//   365日のお客様の発言から相場・予算の問いらしい候補（広め）を集め、10/07 に足した形（customerAsksRentLevelExtra）だけで当たる通と、
//   その後のスタッフの手打ち（6時間以内）を並べて全部読む。スタッフが相場の事実で答えた通が過半数なら材料を渡す線として正しい。
// 実行: npx tsx --env-file=.env.local scripts/audit-rent-question-1007.ts
import { createClient } from "@supabase/supabase-js";
import { customerAsksRentLevel, customerAsksRentLevelExtra } from "../app/lib/rent-question";
import { isTestConversation } from "../app/lib/test-conversations";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const BROAD = /(相場|家賃|予算|[0-9０-９.．]+\s*万|LDK|DK|1K|ワンルーム|間取り)/i;
const ASKISH = /[？?]|ですか|ますか|でしょうか|ですよね|ますよね|かな|かね|厳し|難し|ない|無い|上が|高く|出てき|出ます/;
(async () => {
  const rows: Array<{ conversation_id: string; created_at: string; text: string }> = [];
  for (let f = 0; f < 200_000; f += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, created_at, text").eq("sender", "customer").gte("created_at", new Date(Date.now() - 365 * 86400_000).toISOString()).order("created_at").range(f, f + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) if (!isTestConversation(r.conversation_id) && r.text && r.text.length < 160 && !/^\s*\[画像\]/.test(r.text) && BROAD.test(r.text) && ASKISH.test(r.text)) rows.push(r as never);
    if ((data ?? []).length < 1000) break;
  }
  let all = 0, extra = 0;
  for (const r of rows) {
    if (customerAsksRentLevel(r.text)) all++;
    if (!customerAsksRentLevelExtra(r.text)) continue;
    extra++;
    const { data } = await sb.from("messages").select("text, is_aix_generated").eq("conversation_id", r.conversation_id).neq("sender", "customer").gt("created_at", r.created_at).lt("created_at", new Date(Date.parse(r.created_at) + 6 * 3600_000).toISOString()).order("created_at").limit(3);
    const staff = (data ?? []).filter((m) => !m.is_aix_generated).map((m) => String(m.text ?? "")).join(" / ").replace(/\s+/g, " ").slice(0, 160);
    console.log(`○ ${r.created_at.slice(0, 10)} ${r.text.replace(/\s+/g, " ").slice(0, 90)}\n   人: ${staff || "（6時間以内の手打ちなし）"}`);
  }
  console.log(`\n候補 ${rows.length}・当たる ${all}・10/07 の形だけで当たる ${extra}`);
})();
