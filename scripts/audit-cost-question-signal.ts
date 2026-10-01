// scripts/audit-cost-question-signal.ts — 信号0.96/1（費用の質問→AIX【見積書送る】）の線を実送信で引く（読むだけ・LLM なし）
// 2026-10-01 YUMA の再生（scripts/yuma-replay-scenarios.ts）で「初期費用の支払いはいつですか？」「家賃をいくらまでにしたら…物件が出てきますか？」が
//   signal:estimate_sheet になり、スタッフは手打ちで答えていた（穴:G5）。費用の質問の形ごとに、スタッフが返事のまとまりで見積書送るを押したかを数える。
// 実行: npx tsx --env-file=.env.local scripts/audit-cost-question-signal.ts [--days=180] [--show=支払い]
import { createClient } from "@supabase/supabase-js";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
import { CUSTOMER_ESTIMATE_INTENT_RE, FORM_LABEL_RE, isConditionFormMessage } from "../app/lib/line-reply-prompts";
import { costQuestionNotEstimate } from "../app/lib/cost-question-kind";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "180"));
const SHOW = arg("show", "");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
type Msg = WindowMsg & { conversation_id: string };
type Press = WindowPress & { conversation_id: string };
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs = await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, t));
  const presses = await readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t));
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = by(msgs), pBy = by(presses);
  const tally = new Map<string, { n: number; est: number; other: number; text: number; ex: string[] }>();
  for (const [cid, ms] of mBy) {
    if (isTestConversation(cid)) continue;
    const ps = pBy.get(cid) ?? [];
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].sender !== "customer" || (i > 0 && ms[i - 1].sender === "customer")) continue;
      const turn: string[] = [];
      for (let j = i; j < ms.length && ms[j].sender === "customer"; j++) turn.push(ms[j].text ?? "");
      const t = turn.join("\n");
      if (isConditionFormMessage(t) || !CUSTOMER_ESTIMATE_INTENT_RE.test(t.replace(FORM_LABEL_RE, " "))) continue;
      const w = staffWindowOf({ customerTurnAt: ms[i].created_at, msgs: ms, presses: ps });
      if (!w.closed || !w.staffFirstAt) continue;
      const burst = w.presses.filter((p) => p.burst).map((p) => p.aix_type);
      const kind = costQuestionNotEstimate(t) ?? "その他の費用の質問";
      const row = tally.get(kind) ?? { n: 0, est: 0, other: 0, text: 0, ex: [] };
      row.n++;
      if (burst.includes("estimate_sheet")) row.est++; else if (burst.length) row.other++; else row.text++;
      if (row.ex.length < 40) row.ex.push(`${burst.join("+") || "手打ち"}｜${t.replace(/\n/g, " ").slice(0, 90)}`);
      tally.set(kind, row);
    }
  }
  for (const [k, r] of [...tally].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${k.padEnd(16)} n=${r.n} 見積書送る=${r.est} 他のAIX=${r.other} 手打ち=${r.text}`);
    if (SHOW && k.includes(SHOW) || (!SHOW && k !== "その他の費用の質問")) for (const e of r.ex) console.log(`    ${e}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
