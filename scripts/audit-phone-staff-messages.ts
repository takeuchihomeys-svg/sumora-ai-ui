// scripts/audit-phone-staff-messages.ts — 電話の場面でスタッフが実際に書いた文（人の文）を集める（読むだけ・LLM なし）
// 2026-10-02 竹内さんの決定「電話をかける の AIX の文は会話に合わせる（聞かれた時間に答える・文脈に触れる・電話の要の文は残す）」:
//   手本は人が書いた文だけ（AIX の定型そのまま＝「お電話大丈夫です😊！！\nこちらの電話をかけるボタンよりお電話お願い致します！！」は除く）。
//   お客様の電話の依頼（phone-call.customerRequestsPhoneCall）の番と、ボタンの送付（[通話リクエスト]）の前後のスタッフの文を出す。
// 実行: npx tsx --env-file=.env.local scripts/audit-phone-staff-messages.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
import { customerRequestsPhoneCall, CALL_BUTTON_MESSAGE_TEXT } from "../app/lib/phone-call";
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "365");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
const TEMPLATE_RE = /^お電話大丈夫です😊！！\nこちらの電話をかけるボタンよりお電話お願い致します！！$/;
type Msg = WindowMsg & { conversation_id: string };
type Press = WindowPress & { conversation_id: string };
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs = await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, t));
  const presses = await readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t));
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = by(msgs), pBy = by(presses);
  let n = 0, human = 0, tmpl = 0, button = 0;
  for (const [cid, ms] of mBy) {
    if (isTestConversation(cid)) continue;
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].sender !== "customer" || (i > 0 && ms[i - 1].sender === "customer")) continue;
      const turn: string[] = [];
      for (let j = i; j < ms.length && ms[j].sender === "customer"; j++) turn.push(ms[j].text ?? "");
      const t = turn.join("\n");
      if (!customerRequestsPhoneCall(t)) continue;
      const w = staffWindowOf({ customerTurnAt: ms[i].created_at, msgs: ms, presses: pBy.get(cid) ?? [] });
      if (!w.closed) continue;
      n++;
      const texts = w.texts.filter((x) => x.burst).map((x) => x.text);
      const hasButton = texts.some((x) => x.includes(CALL_BUTTON_MESSAGE_TEXT)) || w.presses.some((p) => p.aix_type === "phone_call");
      if (hasButton) button++;
      const body = texts.filter((x) => !x.includes(CALL_BUTTON_MESSAGE_TEXT)).join("\n／\n");
      const isTmpl = texts.some((x) => TEMPLATE_RE.test(x.trim()));
      if (isTmpl) tmpl++; else human++;
      console.log(`\n--- ${cid.slice(0, 8)} ${ms[i].created_at.slice(0, 16)} ${hasButton ? "📞ボタン" : ""}${isTmpl ? "［定型そのまま］" : "［人の文］"}\nC: ${t.replace(/\n/g, " ").slice(0, 160)}\nS: ${body.replace(/\n/g, "⏎").slice(0, 300)}`);
    }
  }
  console.log(`\n電話の依頼 ${n}番（${DAYS}日）: ボタンを送った ${button}・人の文 ${human}・定型そのまま ${tmpl}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
