// scripts/audit-r7-viewing-day-notice.ts — 7巡目: reply-subscene.isViewingDayNotice が当たるお客様の番と、その時のスタッフの最初の手打ちの返事を全部並べる（読むだけ・LLM なし）
//   線を引いた根拠（人 12/17 が「かしこまりました！！⏎お気をつけてお越しください😌！！」）を確かめる・誤当たりを目で読む
// 実行: npx tsx --env-file=.env.local scripts/audit-r7-viewing-day-notice.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { isViewingDayNotice } from "../app/lib/reply-subscene";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
(async () => {
  const since = new Date(Date.now() - Number(arg("days", "365")) * 86_400_000).toISOString();
  const msgs: Array<{ conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null }> = [];
  for (let i = 0; i < 400_000; i += 1000) { const { data } = await sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(i, i + 999); msgs.push(...((data ?? []) as typeof msgs)); if ((data ?? []).length < 1000) break; }
  const by = new Map<string, typeof msgs>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  let n = 0, tpl = 0;
  for (const [, list] of by) for (let i = 0; i < list.length; i++) {
    if (list[i].sender !== "customer" || (i > 0 && list[i - 1].sender === "customer")) continue;
    let j = i; while (j + 1 < list.length && list[j + 1].sender === "customer") j++;
    const text = list.slice(i, j + 1).map((m) => m.text ?? "").join("\n");
    if (!isViewingDayNotice(text)) continue;
    const st = list.slice(j + 1).find((x) => x.sender === "staff" && !x.is_aix_generated && (x.text ?? "").trim() && !/^\[/.test(x.text ?? ""));
    n++;
    const ok = !!st && /^かしこまりました！！\s*\n?\s*お気をつけてお越し(?:ください|下さい)[😊😌]*！！\s*$/.test((st.text ?? "").trim());
    if (ok) tpl++;
    console.log(`${ok ? "○" : "×"} C「${text.replace(/\n/g, " ").slice(0, 60)}」→ 人「${(st?.text ?? "（返事なし）").replace(/\n/g, "⏎").slice(0, 70)}」`);
  }
  console.log(`当たる番 ${n}・人がこの2行の形 ${tpl}`);
})();
