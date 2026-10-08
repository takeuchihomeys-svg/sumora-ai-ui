// scripts/audit-r8-free-rent.ts — 8巡目（10/08 竹内「フリーレントはスタッフが入れていた物件だけ」）の監査（読むだけ・LLM なし）
//   A. スタッフの送信（180日）の「フリーレント」→ staff-free-rent の事実（物件・種類・文）を全部表示（誤読を目で読む）
//   B. AI の下書き（見張り draft_first/last・ai_reply_examples.ai_draft・90日）でフリーレントに触れた物 → 出口が当たるか（その会話でその番より前のスタッフの事実と）
//   C. スタッフの手打ちが先にフリーレントを言った番（その前にスタッフの事実が無い）＝人だけが知っていた数
// 実行: npx tsx --env-file=.env.local scripts/audit-r8-free-rent.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { freeRentFactsFromStaffText, collectStaffFreeRent, ungroundedFreeRentSentence } from "../app/lib/staff-free-rent";

const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 180);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const one = (t: string, n = 140) => String(t ?? "").replace(/\r?\n/g, "␤").replace(/[^\s、。！!]{1,10}(さん|様)/g, "〇〇$1").slice(0, n);
type M = { conversation_id: string; text: string | null; created_at: string; is_aix_generated: boolean | null };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data } = await sb.from("messages").select("conversation_id, text, created_at, is_aix_generated").eq("sender", "staff").ilike("text", "%フリーレント%").gte("created_at", since).order("created_at").limit(3000);
  const staff = ((data ?? []) as M[]).filter((r) => !isTestConversation(r.conversation_id));
  console.log(`A. スタッフの送信 ${DAYS}日 フリーレントを含む ${staff.length}通（AIX ${staff.filter((r) => r.is_aix_generated).length}）`);
  const byKind: Record<string, number> = {};
  for (const r of staff) {
    const fs = freeRentFactsFromStaffText(r.text, r.created_at);
    if (!fs.length) { console.log(`  ・事実なし ${r.created_at.slice(0, 10)} ${r.conversation_id.slice(0, 6)} ${one(r.text ?? "")}`); byKind.skip = (byKind.skip ?? 0) + 1; continue; }
    for (const f of fs) { byKind[f.kind] = (byKind[f.kind] ?? 0) + 1; console.log(`  ${f.kind.padEnd(10)} ${r.created_at.slice(0, 10)} ${r.conversation_id.slice(0, 6)} [${f.property ?? "-"}] ${one(f.phrase, 100)}`); }
  }
  console.log(`  種類: ${JSON.stringify(byKind)}`);

  const byConv = new Map<string, M[]>();
  for (const r of staff) { const a = byConv.get(r.conversation_id) ?? []; a.push(r); byConv.set(r.conversation_id, a); }
  const factsBefore = (conv: string, at: string) => collectStaffFreeRent((byConv.get(conv) ?? []).filter((m) => m.created_at < at).map((m) => ({ text: m.text, createdAt: m.created_at })));

  const s90 = new Date(Date.now() - Math.min(DAYS, 90) * 86_400_000).toISOString();
  const { data: turns } = await sb.from("line_watch_turns").select("conversation_id, customer_turn_at, draft_first, draft_last").gte("customer_turn_at", s90).or("draft_first.ilike.%フリーレント%,draft_last.ilike.%フリーレント%").limit(2000);
  const { data: ex } = await sb.from("ai_reply_examples").select("conversation_id, created_at, ai_draft, sent_reply").gte("created_at", s90).ilike("ai_draft", "%フリーレント%").limit(2000);
  const drafts = [
    ...((turns ?? []) as Array<{ conversation_id: string; customer_turn_at: string; draft_first: string | null; draft_last: string | null }>).flatMap((t) => [t.draft_first, t.draft_last].filter((d): d is string => !!d && d !== "__SHOWN__" && /フリーレント/.test(d)).map((d) => ({ conv: t.conversation_id, at: t.customer_turn_at, d, sent: null as string | null }))),
    ...((ex ?? []) as Array<{ conversation_id: string; created_at: string; ai_draft: string | null; sent_reply: string | null }>).map((e) => ({ conv: e.conversation_id, at: e.created_at, d: e.ai_draft ?? "", sent: e.sent_reply })),
  ].filter((x) => x.conv && !isTestConversation(x.conv));
  let hit = 0;
  console.log(`\nB. AI の下書き（${Math.min(DAYS, 90)}日）でフリーレントに触れた ${drafts.length}件`);
  for (const x of drafts) {
    const facts = factsBefore(x.conv, x.at);
    const s = ungroundedFreeRentSentence(x.d, facts);
    if (s) hit++;
    console.log(`  ${s ? "✗止める" : "○通す  "} ${x.at.slice(0, 10)} ${x.conv.slice(0, 6)} 事実${facts.length}（${facts.map((f) => f.kind).join(",")}） 下書き「${one(s ?? x.d.split("\n").find((l) => /フリーレント/.test(l)) ?? "", 90)}」${x.sent != null ? `\n           送信「${one(x.sent.split("\n").find((l) => /フリーレント/.test(l)) ?? "（フリーレントに触れず）", 90)}」` : ""}`);
  }
  console.log(`  出口が止める ${hit}／${drafts.length}`);

  let first = 0;
  console.log(`\nC. スタッフの手打ちが先に「付く」と言った番（それより前にスタッフの事実なし）`);
  for (const r of staff.filter((m) => !m.is_aix_generated)) {
    const fs = freeRentFactsFromStaffText(r.text, r.created_at).filter((f) => f.kind !== "none");
    if (!fs.length) continue;
    if (factsBefore(r.conversation_id, r.created_at).some((f) => f.kind !== "none")) continue;
    first++;
    console.log(`  ${r.created_at.slice(0, 10)} ${r.conversation_id.slice(0, 6)} ${one(fs[0].phrase, 100)}`);
  }
  console.log(`  ${first}通`);
}
main().catch((e) => { console.error(e); process.exit(1); });
