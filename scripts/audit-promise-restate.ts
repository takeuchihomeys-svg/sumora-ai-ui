// scripts/audit-promise-restate.ts — 約束の言い直しの見分け（promise-restate.ts）を、本番の下書きと送った文に当てる（読むだけ・LLM なし・費用0）
//
// 2026-11-21 作業員K2（台帳 #442）: AI の下書き（ai_reply_examples.ai_draft）と送った文（sent_reply）それぞれに promiseRestates を当て、
//   「AI だけが約束を言い直した」番（下書きは restate・送った文には同じ中身の約束の言い直しが無い）と、「両方とも言い直した」番（見分けが誤って拾う候補）を数える。
//   前のこちらの通＝その番より前の staff の通（14日以内・最大8通・AIX を含む）。お客様のこの番＝直前の customer の束。
//   文は出さない（会話の頭6字・型・中身の数だけ）。--show の時だけ手元に頭40字。
// 重い読み: 30日の ai_reply_examples と会話ごとの messages（22時以降）。
// 実行: npx tsx --env-file=.env.local scripts/audit-promise-restate.ts [--days=30] [--show]
import { createClient } from "@supabase/supabase-js";
import { promiseRestates } from "../app/lib/promise-restate";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Ex = { conversation_id: string | null; ai_draft: string | null; sent_reply: string | null; sent_at: string | null; created_at: string };
type M = { sender: string; text: string | null; created_at: string };
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "30")) || 30;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data, error } = await sb.from("ai_reply_examples").select("conversation_id, ai_draft, sent_reply, sent_at, created_at").eq("entry_source", "line_reply").gte("created_at", since).not("ai_draft", "is", null).limit(3000);
  if (error) throw new Error(error.message);
  const exs = ((data ?? []) as Ex[]).filter((e) => e.conversation_id && !isTestConversation(e.conversation_id) && !isNoLineTestConversation(e.conversation_id) && (e.sent_reply ?? "").trim());
  const byConv = new Map<string, Ex[]>(); for (const e of exs) byConv.set(e.conversation_id!, [...(byConv.get(e.conversation_id!) ?? []), e]);
  const t = { n: 0, aiRestate: 0, aiOnly: 0, both: 0, sentOnly: 0, reminder: 0, newScope: 0 };
  const topics: Record<string, number> = {}; const bothTopics: Record<string, number> = {};
  for (const [c, list] of byConv) {
    const from = new Date(Date.parse(list.map((e) => e.sent_at ?? e.created_at).sort()[0]) - 14 * 864e5).toISOString();
    const { data: md } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", c).gte("created_at", from).order("created_at").limit(3000);
    const ms = (md ?? []) as M[];
    for (const e of list) {
      const at = Date.parse(e.sent_at ?? e.created_at);
      const before = ms.filter((m) => Date.parse(m.created_at) < at - 5000);
      let i = before.length - 1; const cust: string[] = [];
      while (i >= 0 && before[i].sender === "customer") { cust.unshift(String(before[i].text ?? "")); i--; }
      if (!cust.length) continue;
      const prior = before.slice(0, i + 1).filter((m) => m.sender !== "customer" && at - Date.parse(m.created_at) <= 14 * 864e5).slice(-8).reverse().map((m) => String(m.text ?? ""));
      t.n++;
      const d = promiseRestates(String(e.ai_draft ?? ""), prior, cust), s = promiseRestates(String(e.sent_reply ?? ""), prior, cust);
      const dR = d.filter((h) => h.kind === "restate"), sR = s.filter((h) => h.kind === "restate");
      if (d.some((h) => h.kind === "reminder")) t.reminder++;
      if (d.some((h) => h.kind === "new_scope")) t.newScope++;
      if (dR.length) t.aiRestate++;
      if (dR.length && !sR.length) { t.aiOnly++; for (const h of dR) topics[h.topic] = (topics[h.topic] ?? 0) + 1; if (process.argv.includes("--show")) console.log(c.slice(0, 6), dR.map((h) => h.topic).join(","), "| AI:", dR[0].sentence.slice(0, 40)); }
      if (dR.length && sR.length) { t.both++; for (const h of dR) bothTopics[h.topic] = (bothTopics[h.topic] ?? 0) + 1; }
      if (!dR.length && sR.length) t.sentOnly++;
    }
  }
  console.log(`約束の言い直しの見分け（${days}日・番 ${t.n}）: 下書きが言い直した ${t.aiRestate}・AI だけ ${t.aiOnly}・送った文も言い直した ${t.both}・送った文だけ ${t.sentOnly}（催促の番 ${t.reminder}・新しい条件の番 ${t.newScope}）`);
  console.log(`  送った文も言い直した番の中身: ${Object.entries(bothTopics).map(([k, v]) => `${k} ${v}`).join("・") || "なし"}`);
  console.log(`  AI だけの中身: ${Object.entries(topics).map(([k, v]) => `${k} ${v}`).join("・") || "なし"}`);
})().catch((e) => { console.error(e); process.exit(1); });
