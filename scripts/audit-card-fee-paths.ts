// scripts/audit-card-fee-paths.ts — 「カード払い・分割が出来る」と答えた文に手数料（3.24%）が入っているかを、道ごとに数える（読むだけ・LLM なし）
// 2026-10-02 竹内さん「分割もクレジットカードの手数料いれる」: 返信生成の下書き（ai_reply_examples.ai_draft）・AIX の生成（aix_generate_log）・
//   スタッフの実送信（messages）のどこで手数料が抜けるか。ゲート（お客様が聞いているか）は付けずに本文だけで見る。
// 実行: npx tsx --env-file=.env.local scripts/audit-card-fee-paths.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { findMissingCardFee } from "../app/lib/company-fact-guard";
import { isTestConversation } from "../app/lib/test-conversations";
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "180");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const ASK = ["初期費用って分割できますか？"]; // ゲートを開けて本文だけで見る
async function scan(label: string, rows: Array<{ id?: string; conversation_id?: string | null; created_at: string; text: string | null }>) {
  let card = 0, missing = 0;
  for (const r of rows) {
    if (!r.text || (r.conversation_id && isTestConversation(r.conversation_id))) continue;
    if (!/(?:クレジット|クレカ|カード)[^。\n]{0,24}(?:分割|払い|決済)/.test(r.text)) continue;
    card++;
    const h = findMissingCardFee(r.text, ASK);
    if (h) { missing++; console.log(`  [${label}] ${r.created_at.slice(0, 10)}｜${h.sentence.slice(0, 80)}`); }
  }
  console.log(`${label}: カード払い・分割の文 ${card}・手数料なしで出来ると答えた ${missing}`);
}
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const ex = (await sb.from("ai_reply_examples").select("conversation_id, created_at, ai_draft").gte("created_at", since).or("ai_draft.ilike.%カード%,ai_draft.ilike.%クレジット%").limit(2000)).data ?? [];
  await scan("返信生成の下書き", ex.map((e) => ({ conversation_id: e.conversation_id, created_at: e.created_at, text: e.ai_draft })));
  const ag = (await sb.from("aix_generate_log").select("conversation_id, created_at, generated_text").gte("created_at", since).or("generated_text.ilike.%カード%,generated_text.ilike.%クレジット%").limit(2000)).data ?? [];
  await scan("AIX の生成", ag.map((e) => ({ conversation_id: e.conversation_id, created_at: e.created_at, text: e.generated_text })));
  const ms = (await sb.from("messages").select("conversation_id, created_at, text").neq("sender", "customer").gte("created_at", since).or("text.ilike.%カード%,text.ilike.%クレジット%").limit(2000)).data ?? [];
  await scan("スタッフの実送信", ms);
}
main().catch((e) => { console.error(e); process.exit(1); });
