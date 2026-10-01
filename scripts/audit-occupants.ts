// scripts/audit-occupants.ts — お客様の発言から入居人数を読む線（co-resident.occupantsFromText）を、365日の発言に当てて手がかりの周り（前後20字）だけ出す（読むだけ・LLM なし）
// 2026-10-02 竹内さん「条件ヒアリングに入居人数を足す」。個人の値は出さない（手がかりの語の周りだけ）。
// 実行: npx tsx --env-file=.env.local scripts/audit-occupants.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { occupantsFromText } from "../app/lib/co-resident";
import { isTestConversation } from "../app/lib/test-conversations";
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "365");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Array<{ conversation_id: string; created_at: string; text: string }> = [];
  for (let i = 0; ; i += 1000) {
    const r = await sb.from("messages").select("conversation_id, created_at, text").eq("sender", "customer").gte("created_at", since)
      .or("text.ilike.%人数%,text.ilike.%人入居%,text.ilike.%人で%,text.ilike.%人暮らし%,text.ilike.%単身%,text.ilike.%同棲%,text.ilike.%夫婦%,text.ilike.%大人%,text.ilike.%家族%").order("created_at").range(i, i + 999);
    if (r.error) throw r.error; rows.push(...(r.data as typeof rows)); if ((r.data ?? []).length < 1000) break;
  }
  const by = new Map<number, number>(); let hit = 0;
  for (const m of rows) {
    if (isTestConversation(m.conversation_id) || /【お申込者様記入欄】|生年月日|年収/.test(m.text)) continue;
    const h = occupantsFromText(m.text);
    if (!h) continue;
    hit++; by.set(h.count, (by.get(h.count) ?? 0) + 1);
    const t = m.text.normalize("NFKC"); const i = Math.max(0, t.indexOf(h.evidence.split(" ")[0]));
    console.log(`${h.count}名｜${h.evidence}｜…${t.slice(Math.max(0, i - 20), i + 25).replace(/\n/g, " ")}…`);
  }
  console.log(`\n候補 ${rows.length}通・人数を読めた ${hit}・人数別 ${JSON.stringify(Object.fromEntries(by))}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
