// scripts/audit-owner-answers-1021.ts — 2026-10-21 竹内さんの答え（AIX 側）の網を実データに当てて数える（読むだけ・LLM なし・本文は出さない）
//   C2/C3 isOtherAgentCostCompare（お客様の発言）／C6 mentionsOtherAgentProperty（見積書を送った番の直前の会話）／C5 isEstimateCorrectionContext
// 実行: npx tsx --env-file=.env.local scripts/audit-owner-answers-1021.ts [--days=90]
import { createClient } from "@supabase/supabase-js";
import { isOtherAgentCostCompare, mentionsOtherAgentProperty, isEstimateCorrectionContext } from "../app/lib/aix-owner-answers-1021";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=90").slice(7)) || 90;
type M = { conversation_id: string; sender: string; text: string | null; created_at: string };

async function main() {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: M[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at").gte("created_at", since).order("created_at").range(from, from + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as M[]));
    if (!data || data.length < 1000) break;
  }
  const byConv = new Map<string, M[]>();
  for (const r of rows) { if (!byConv.has(r.conversation_id)) byConv.set(r.conversation_id, []); byConv.get(r.conversation_id)!.push(r); }
  let cust = 0, compare = 0;
  let estCards = 0, estOther = 0, estOtherHasLine = 0, estCorr = 0, estCorrHasWord = 0;
  for (const msgs of byConv.values()) {
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.sender === "customer") { cust++; if (isOtherAgentCostCompare(m.text)) compare++; continue; }
      if (!/初期費用[：:]\s*[0-9０-９,，]+円/.test(m.text ?? "")) continue;
      // 見積書の本体（1通目）。その番の2通目（30分以内のこちらの文）に何を書いたか
      if (i > 0 && msgs[i - 1].sender !== "customer" && /初期費用[：:]/.test(msgs[i - 1].text ?? "")) continue; // 同じ番の2枚目
      estCards++;
      const before = msgs.slice(Math.max(0, i - 40), i).map((x) => ({ sender: x.sender, text: x.text }));
      const t0 = Date.parse(m.created_at);
      const after = msgs.slice(i + 1).filter((x) => x.sender !== "customer" && Date.parse(x.created_at) - t0 < 30 * 60_000).map((x) => x.text ?? "").join("\n");
      if (mentionsOtherAgentProperty(before, {})) { estOther++; if (/弊社(?:でも|にて|で)[^\n]{0,12}(?:お申込|お申し込|ご内覧|ご内見|内覧|内見)/.test(after + (m.text ?? ""))) estOtherHasLine++; }
      if (isEstimateCorrectionContext(before, null, {})) { estCorr++; if (/訂正|修正/.test(after + (m.text ?? ""))) estCorrHasWord++; }
    }
  }
  console.log(JSON.stringify({ days, customerMessages: cust, costCompareHits: compare, estimateCards: estCards,
    otherAgentEstimate: estOther, otherAgentEstimateWithHereLine: estOtherHasLine, correctionEstimate: estCorr, correctionEstimateWithWord: estCorrHasWord }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
