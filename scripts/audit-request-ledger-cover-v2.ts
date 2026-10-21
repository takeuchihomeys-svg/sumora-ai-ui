// scripts/audit-request-ledger-cover-v2.ts — request-ledger の cover v2（2026-10-13 ゆなまる）の前後で状態が変わった項目を、根拠の送信と並べて目で読む（読むだけ・LLM なし）
//   旧（REQUEST_LEDGER_COVER_V2=off）と新で、①新しく済みになった（取りこぼしを拾った／誤って済みにした）②済みでなくなった ③種類が変わった を出す
// 実行: npx tsx --env-file=.env.local scripts/audit-request-ledger-cover-v2.ts [--days=30]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { buildRequestLedger, TOPIC_JA, type LedgerMsg, type LedgerItem } from "../app/lib/request-ledger";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "30"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
type M = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };
const one = (s: string | null | undefined, n: number) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs: M[] = [];
  for (let i = 0; i < 400_000; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(i, i + 999);
    if (error) throw new Error(error.message); msgs.push(...((data ?? []) as M[])); if ((data ?? []).length < 1000) break;
  }
  const by = new Map<string, LedgerMsg[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated }); }
  const now = Date.now();
  const cnt = { newDone: 0, lostDone: 0, topic: 0, promisedToDone: 0, openToPromised: 0, total: 0 };
  for (const [cid, list] of by) {
    process.env.REQUEST_LEDGER_COVER_V2 = "off"; const a = buildRequestLedger(list, now, { windowDays: DAYS });
    delete process.env.REQUEST_LEDGER_COVER_V2; const b = buildRequestLedger(list, now, { windowDays: DAYS });
    const key = (x: LedgerItem) => `${x.saidAt}|${x.quote}`;
    const am = new Map(a.map((x) => [key(x), x]));
    for (const y of b) {
      cnt.total++;
      const x = am.get(key(y));
      if (!x) continue;
      const ev = (z: LedgerItem) => one(list.find((m) => m.createdAt === z.doneAt && m.sender !== "customer")?.text, 170);
      if (x.topic !== y.topic) { cnt.topic++; console.log(`TOPIC ${cid.slice(0, 8)} ${y.saidAt.slice(5, 16)} ${TOPIC_JA[x.topic]}→${TOPIC_JA[y.topic]}「${one(y.quote, 60)}」 ${x.status}→${y.status}`); }
      if (x.status !== "done" && y.status === "done") { cnt.newDone++; if (x.status === "promised") cnt.promisedToDone++; console.log(`NEWDONE(${x.status}) ${cid.slice(0, 8)} ${y.saidAt.slice(5, 16)} [${TOPIC_JA[y.topic]}]「${one(y.quote, 60)}」← ${y.doneBy}: ${ev(y)}`); }
      if (x.status === "done" && y.status !== "done") { cnt.lostDone++; console.log(`LOST ${cid.slice(0, 8)} ${y.saidAt.slice(5, 16)} [${TOPIC_JA[y.topic]}]「${one(y.quote, 60)}」 was ${x.doneBy}: ${ev(x)}`); }
      if (x.status === "open" && y.status === "promised") { cnt.openToPromised++; console.log(`PROMISED ${cid.slice(0, 8)} [${TOPIC_JA[y.topic]}]「${one(y.quote, 60)}」`); }
    }
  }
  console.log(`\n項目 ${cnt.total}・新しく済み ${cnt.newDone}（約束済みから ${cnt.promisedToDone}）・済みでなくなった ${cnt.lostDone}・未対応→約束済み ${cnt.openToPromised}・種類が変わった ${cnt.topic}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
