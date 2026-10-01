// scripts/audit-payment-timing.ts — 初期費用を「いつ」払うかの質問と、スタッフの答え方（読むだけ）
// 2026-10-01 YUMA の再生: 「初期費用の支払いはいつですか？」の下書きが「管理会社の規定により異なるため確認させて頂きます」（スタッフは「ご入居日から5日から1週間ほど前」と即答）。
//   company-facts の credit_card（支払い方法）は「いつ」を拾わない（穴:G1）。スタッフの答えの形を数えて事実の文を決める。
// 実行: npx tsx --env-file=.env.local scripts/audit-payment-timing.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { isPaymentTimingQuestion } from "../app/lib/company-facts";
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 365);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  // スタッフの答え方
  const staff: Array<{ text: string; conversation_id: string }> = [];
  for (let i = 0; i < 100_000; i += 1000) {
    const { data } = await sb.from("messages").select("text, conversation_id").neq("sender", "customer").gte("created_at", since).or("text.ilike.%1週間%前%,text.ilike.%請求書%").range(i, i + 999);
    staff.push(...((data ?? []) as typeof staff)); if ((data ?? []).length < 1000) break;
  }
  const pay = staff.filter((m) => !isTestConversation(m.conversation_id) && /(支払|振込|お振り込み|ご入金)/.test(m.text ?? ""));
  const a = pay.filter((m) => /5日(?:から|〜|~|－|-)\s*1週間|5日から１週間|５日から１週間/.test(m.text));
  const b = pay.filter((m) => /請求書/.test(m.text));
  console.log(`支払いの時期を書いたスタッフの文: ${pay.length}（「入居日の5日〜1週間前」${a.length}・「請求書」${b.length}）`);
  for (const m of [...a.slice(0, 6), ...b.slice(0, 6)]) console.log(`   ${m.text.replace(/\n/g, " ").slice(0, 120)}`);
  // お客様の質問
  const cust: Array<{ text: string; conversation_id: string }> = [];
  for (let i = 0; i < 100_000; i += 1000) {
    const { data } = await sb.from("messages").select("text, conversation_id").eq("sender", "customer").gte("created_at", since).or("text.ilike.%払%,text.ilike.%振込%,text.ilike.%振り込%").range(i, i + 999);
    cust.push(...((data ?? []) as typeof cust)); if ((data ?? []).length < 1000) break;
  }
  const q = cust.filter((m) => !isTestConversation(m.conversation_id) && isPaymentTimingQuestion(m.text ?? ""));
  console.log(`\n支払いの時期の質問と読んだお客様の発言: ${q.length}`);
  for (const m of q) console.log(`   ${m.text.replace(/\n/g, " ").slice(0, 100)}`);
})().catch((e) => { console.error(e); process.exit(1); });
