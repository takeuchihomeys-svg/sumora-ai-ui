// 2026-10-20 会社の事実の窓（旧: お客様の直近3通 / 新: 今回の番＝こちらの最後の送信より後のお客様の発言）で当たりが変わる番を数える（SELECT だけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-company-fact-turn-scope.ts --days=30
import { createClient } from "@supabase/supabase-js";
import { matchCompanyFacts, customerTextsForCompanyFacts } from "../app/lib/company-facts";

const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").split("=")[1]);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);

type M = { conversation_id: string; sender: string; text: string | null; created_at: string };
async function main() {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: M[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("messages").select("conversation_id, sender, text, created_at").gte("created_at", since)
      .order("conversation_id").order("created_at").range(from, from + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as M[]));
    if (!data || data.length < 1000) break;
  }
  const byConv = new Map<string, M[]>();
  for (const r of rows) { const a = byConv.get(r.conversation_id) ?? []; a.push(r); byConv.set(r.conversation_id, a); }
  let turns = 0, staleAny = 0, staleOther = 0; const staleConvs = new Set<string>(), staleOtherConvs = new Set<string>();
  const byFact = new Map<string, number>();
  for (const [cid, msgs] of byConv) {
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].sender !== "customer") continue;
      // 番の終わり（次がこちらの送信 or 最後）だけ数える＝下書きが作られる時点
      if (i + 1 < msgs.length && msgs[i + 1].sender === "customer") continue;
      turns++;
      const upTo = msgs.slice(0, i + 1);
      const oldIds = new Set(matchCompanyFacts(customerTextsForCompanyFacts(upTo, { env: { COMPANY_FACT_TURN_SCOPE: "off" } })).map((f) => f.id));
      const newIds = new Set(matchCompanyFacts(customerTextsForCompanyFacts(upTo, { env: {} })).map((f) => f.id));
      const stale = [...oldIds].filter((id) => !newIds.has(id));
      if (stale.length) { staleAny++; staleConvs.add(cid); for (const id of stale) byFact.set(id, (byFact.get(id) ?? 0) + 1); }
      if (stale.includes("other_company_viewing")) { staleOther++; staleOtherConvs.add(cid); }
    }
  }
  console.log(JSON.stringify({ days, messages: rows.length, conversations: byConv.size, turns, staleAny, staleAnyConvs: staleConvs.size, staleOther, staleOtherConvs: staleOtherConvs.size, byFact: Object.fromEntries([...byFact].sort((a, b) => b[1] - a[1])) }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
