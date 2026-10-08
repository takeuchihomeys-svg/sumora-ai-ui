// scripts/audit-r8-contract-terms.ts — 8巡目: お客様の契約条件の質問（礼金・敷金・フリーレント・保証会社・退去予定・駐車場・保証人・管理会社）と
//   スタッフの次の手打ち（AIX 以外）を並べる（読むだけ・LLM なし）。言い回しの多数派を目で取る。
// 実行: npx tsx --env-file=.env.local scripts/audit-r8-contract-terms.ts [--days=60] [--topic=key_money] [--show=20]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { detectContractTermTopics, CONTRACT_TERM_LABEL, type ContractTermTopic } from "../app/lib/contract-terms-question";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "60"));
const ONLY = arg("topic", "");
const SHOW = Number(arg("show", "20"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const mask = (t: string) => t.replace(/([^\s、。！!？?「」（）()0-9０-９]{1,8})(さん|様)(?=[\n、。！!])/g, "〇〇$2").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "〇〇");
const one = (t: string, n = 220) => mask(t.replace(/\r?\n|\r/g, "␤").slice(0, n));
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: M[] = [];
  for (let i = 0; i < 300_000; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as M[])); if ((data ?? []).length < 1000) break;
  }
  const byConv = new Map<string, M[]>();
  for (const r of rows) { if (isTestConversation(r.conversation_id)) continue; const a = byConv.get(r.conversation_id) ?? []; a.push(r); byConv.set(r.conversation_id, a); }
  const stat = new Map<ContractTermTopic, { q: number; manual: number; aix: number; none: number }>();
  const shown = new Map<ContractTermTopic, number>();
  for (const [cid, ms] of byConv) {
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (m.sender !== "customer" || !m.text) continue;
      if (i + 1 < ms.length && ms[i + 1].sender === "customer") continue; // 連投の最後だけ
      // 連投をまとめる
      let j = i; const turn: string[] = [];
      while (j >= 0 && ms[j].sender === "customer") { if (ms[j].text) turn.unshift(ms[j].text!); j--; }
      const text = turn.join("\n");
      const topics = detectContractTermTopics(text);
      if (!topics.length) continue;
      const replies: M[] = [];
      for (let k = i + 1; k < ms.length && ms[k].sender !== "customer"; k++) if (Date.parse(ms[k].created_at) - Date.parse(m.created_at) < 36 * 3600_000) replies.push(ms[k]);
      const manual = replies.filter((r) => !r.is_aix_generated && r.text && !/^\[(?:画像|動画|スタンプ|ファイル)/.test(r.text));
      const aix = replies.filter((r) => r.is_aix_generated);
      for (const t of topics) {
        if (ONLY && t !== ONLY) continue;
        const s = stat.get(t) ?? { q: 0, manual: 0, aix: 0, none: 0 }; s.q++;
        if (manual.length) s.manual++; else if (aix.length) s.aix++; else s.none++;
        stat.set(t, s);
        const n = shown.get(t) ?? 0;
        if (n < SHOW) {
          shown.set(t, n + 1);
          console.log(`\n[${CONTRACT_TERM_LABEL[t]}] ${m.created_at.slice(0, 16)} ${cid.slice(0, 8)}\n  客: ${one(text, 160)}`);
          for (const r of replies.slice(0, 3)) console.log(`  ${r.is_aix_generated ? "AIX" : "手 "}: ${one(r.text ?? "", 260)}`);
        }
      }
    }
  }
  console.log(`\n=== ${DAYS}日 質問の番（連投単位）× 次のこちら ===`);
  for (const [t, s] of stat) console.log(`${CONTRACT_TERM_LABEL[t].padEnd(10)} 質問 ${s.q}  手打ち ${s.manual}  AIX だけ ${s.aix}  返事なし ${s.none}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
