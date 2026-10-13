// scripts/audit-aix-reply-asks-split.ts — お客様が質問した番で竹内さんが AIX を送った時、質問への答えを AIX の文の中で書いたか・別の通（手打ち）で書いたか（読むだけ・LLM なし）
//   2026-10-13 確かめる人の重要3: 「返信の依頼を AIX の文の外で受ける」を入れる前に、竹内さんの実際の分け方を数える。
//   番: 竹内さんの AIX（aix_usage_logs・line_message_id の書き手 takeuchi）。最後のお客様の連投に質問（？・ですか・ますか・でしょうか）がある番だけ。
//   別の通＝その連投の後・次のお客様の発言の前に、竹内さんが AIX でない手打ちの文（10字以上）を送った。
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-reply-asks-split.ts [--days=60] [--samples=8]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "60")), SAMPLES = Number(arg("samples", "8"));
const Q_RE = /[？?]|ですか|ますか|でしょうか|ません?か/;
type Msg = { sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null; line_message_id: string | null };
(async () => {
  const { data: ps } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at, sent_at, line_message_id, generated_text").gte("created_at", new Date(Date.now() - DAYS * 86400e3).toISOString()).not("line_message_id", "is", null).order("created_at");
  const presses = ((ps ?? []) as Array<{ conversation_id: string; aix_type: string; created_at: string; sent_at: string | null; line_message_id: string; generated_text: string | null }>).filter((p) => !isTestConversation(p.conversation_id));
  const by: Record<string, { n: number; other: number; inAix: number; none: number; after: number }> = {};
  const samples: string[] = [];
  const cache = new Map<string, Msg[]>();
  for (const p of presses) {
    if (!cache.has(p.conversation_id)) { const { data } = await sb.from("messages").select("sender, text, created_at, is_aix_generated, staff_writer, line_message_id").eq("conversation_id", p.conversation_id).order("created_at").limit(3000); cache.set(p.conversation_id, (data ?? []) as Msg[]); }
    const ms = cache.get(p.conversation_id)!;
    const me = ms.find((m) => m.line_message_id === p.line_message_id);
    if (!me || me.staff_writer !== "takeuchi") continue;
    const t = Date.parse(me.created_at);
    const before = ms.filter((m) => Date.parse(m.created_at) < t);
    let i = before.length - 1; while (i >= 0 && before[i].sender !== "customer") i--;
    if (i < 0) continue;
    let j = i; while (j - 1 >= 0 && before[j - 1].sender === "customer") j--;
    const burst = before.slice(j, i + 1).map((m) => m.text ?? "").join("\n");
    if (!Q_RE.test(burst)) continue;
    const burstEnd = Date.parse(before[i].created_at);
    const nextCust = ms.find((m) => m.sender === "customer" && Date.parse(m.created_at) > t);
    const end = nextCust ? Date.parse(nextCust.created_at) : t + 3 * 3600e3;
    const hand = ms.filter((m) => m.sender !== "customer" && !m.is_aix_generated && m.line_message_id !== p.line_message_id && Date.parse(m.created_at) > burstEnd && Date.parse(m.created_at) < end && (m.text ?? "").trim().length >= 10 && !/^\[/.test((m.text ?? "").trim()));
    const k = p.aix_type; by[k] ??= { n: 0, other: 0, inAix: 0, none: 0, after: 0 }; by[k].n++;
    if (hand.length) { by[k].other++; if (hand.every((m) => Date.parse(m.created_at) > t)) by[k].after++; }
    else { by[k].none++; if (samples.length < SAMPLES * 3) samples.push(`[${p.aix_type}] お客様「${burst.replace(/\n+/g, "／").slice(0, 90)}」\n   AIX「${String(me.text ?? "").replace(/\n+/g, "／").slice(0, 160)}」`); }
  }
  console.log(`# 質問のある番で竹内さんが AIX を送った時（${DAYS}日）`);
  console.log("ボタン｜番｜別の手打ちの通もある（うち AIX の後だけ）｜AIX だけ");
  let N = 0, O = 0, A = 0; for (const [k, v] of Object.entries(by).sort((a, b) => b[1].n - a[1].n)) { N += v.n; O += v.other; A += v.after; console.log(`${k}｜${v.n}｜${v.other}（${v.after}）｜${v.none}`); }
  console.log(`合計｜${N}｜${O}（${A}）｜${N - O}`);
  console.log("\n## AIX だけの番（質問に AIX の文で答えたか目で読む）"); for (const s of samples) console.log(s);
})();
