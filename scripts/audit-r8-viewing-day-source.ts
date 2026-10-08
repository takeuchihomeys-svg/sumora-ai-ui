// scripts/audit-r8-viewing-day-source.ts — 8巡目B: 「お気をつけてお越しください」を含むスタッフの文を全部取り、出所（AIX／内覧挨拶のピッカー／返信の下書き／手打ち）と前後を並べる（読むだけ・LLM なし）
//   2026-10-08 竹内「これはAIXの挨拶では？」（7巡目の内覧当日の連絡の2行の注記について）
// 実行: npx tsx --env-file=.env.local scripts/audit-r8-viewing-day-source.ts
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { isViewingDayNotice, subSceneOf } from "../app/lib/reply-subscene";
import { coreOf, dice } from "../app/lib/text-diff-types";
import { cleanDraft } from "../app/lib/line-watch-judge";
import { writerOf } from "./lib/r8-style-targets";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
type M = { id: string; conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };
const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
(async () => {
  const { data: hits } = await sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated").eq("sender", "staff").ilike("text", "%お気をつけてお越し%").order("created_at");
  const { data: ex } = await sb.from("ai_reply_examples").select("conversation_id, sent_reply, ai_draft, created_at, sent_at, entry_source, aix_action").ilike("sent_reply", "%お気をつけてお越し%");
  const { data: gen } = await sb.from("aix_generate_log").select("conversation_id, action_type, created_at, generated_text").eq("action_type", "greeting_viewing");
  const { data: logs } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, sent_at, created_at, generated_text");
  const rows = (hits ?? []) as M[];
  const tally = new Map<string, number>();
  for (const m of rows) {
    if (isTestConversation(m.conversation_id)) continue;
    const t = (m.text ?? "").trim();
    const { data: ctx } = await sb.from("messages").select("id, sender, created_at, text, is_aix_generated").eq("conversation_id", m.conversation_id).gte("created_at", new Date(Date.parse(m.created_at) - 2 * 86_400_000).toISOString()).lte("created_at", m.created_at).order("created_at");
    const list = (ctx ?? []) as M[];
    const idx = list.findIndex((x) => x.id === m.id);
    const before = list.slice(0, idx);
    let ci = before.length - 1; while (ci >= 0 && before[ci].sender !== "customer") ci--;
    let cj = ci; while (cj - 1 >= 0 && before[cj - 1].sender === "customer") cj--;
    const cust = ci >= 0 ? before.slice(cj, ci + 1).map((x) => x.text ?? "").join(" ") : "";
    const prevStaff = [...before].reverse().find((x) => x.sender === "staff");
    const exHit = (ex ?? []).find((e) => e.conversation_id === m.conversation_id && Math.abs(Date.parse(e.sent_at ?? e.created_at) - Date.parse(m.created_at)) < 30 * 60_000);
    const g = (gen ?? []).find((x) => x.conversation_id === m.conversation_id && Date.parse(x.created_at) <= Date.parse(m.created_at) && Date.parse(m.created_at) - Date.parse(x.created_at) < 6 * 3600_000);
    const lg = (logs ?? []).find((x) => x.conversation_id === m.conversation_id && x.generated_text && dice(coreOf(x.generated_text), coreOf(t)) >= 0.8);
    const draft = exHit ? cleanDraft(exHit.ai_draft).text : null;
    const src = m.is_aix_generated || lg ? `AIX(${lg?.aix_type ?? "?"})` : g && dice(coreOf(g.generated_text ?? ""), coreOf(t)) >= 0.6 ? "内覧挨拶のピッカー" : exHit ? (draft && draft.trim() === t ? "返信の下書きそのまま" : draft && /お気をつけてお越し/.test(draft) ? "返信の下書き（その文あり）を直した" : draft ? "返信の下書き（その文なし）に手で足した" : `返信の欄・下書きなし(${exHit.entry_source}${exHit.aix_action ? ":" + exHit.aix_action : ""})`) : "手打ち（記録なし）";
    const two = /^かしこまりました[😊😌]*！！\s*\n?\s*お気をつけてお越し(?:ください|下さい)[😊😌]*！！\s*$/.test(t);
    const kind = isViewingDayNotice(cust) ? "当日の連絡（遅れる・向かう等）" : /着きました|到着|着いた/.test(cust) ? "着いた" : !cust ? "お客様の発言なし" : "その他";
    const key = `${two ? "2行の形" : "他の形"}｜${src}｜${kind}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
    console.log(`${jst(m.created_at)} ${two ? "■2行" : "□他 "} ${src}｜書き手${writerOf(t)}｜お客様: ${kind}「${cust.replace(/\s+/g, " ").slice(0, 40)}」｜前のこちら: ${prevStaff ? `${prevStaff.is_aix_generated ? "AIX " : ""}${jst(prevStaff.created_at)}「${(prevStaff.text ?? "").replace(/\n/g, "⏎").slice(0, 40)}」` : "-"}\n      → 「${t.replace(/\n/g, "⏎").slice(0, 90)}」${g ? `｜内覧挨拶の生成 ${jst(g.created_at)}「${(g.generated_text ?? "").replace(/\n/g, "⏎").slice(0, 50)}」` : ""}`);
  }
  console.log("\n集計:"); for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${v}  ${k}`);
})();
