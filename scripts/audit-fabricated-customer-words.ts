// scripts/audit-fabricated-customer-words.ts — 最終チェックの1回目が「捏造」とした下書きのうち、お客様自身の言葉の復唱はいくつか（読むだけ・LLM なし）
// 2026-10-02 ⑫⑬の再生で見つけた穴: お客様の「家賃6万まで」を復唱した下書きに FABRICATED_AMOUNT／FABRICATED_PROPERTY、
//   FABRICATED_AVAILABILITY が1回目に付き、書き直しで消えていた（書き直しの費用・時間・文の質）。
//   送った例の記録（reply_context_snapshot.preRevisionCodes＝修正前の指摘）で FABRICATED_* が付いた回を全部出し、
//   下書きの金額・駅名・物件名が「お客様の発言（その回の発言＋直近の会話）」にあるかを数える。
// 実行: npx tsx --env-file=.env.local scripts/audit-fabricated-customer-words.ts [--from=2026-09-10]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";

const FROM = process.argv.find((a) => a.startsWith("--from="))?.slice(7) ?? "2026-09-10";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const AMT = /[0-9０-９]+(?:\.[0-9]+)?\s*万|[0-9０-９][0-9０-９,，]{2,}\s*円/g;
const norm = (s: string) => s.normalize("NFKC").replace(/[\s,，]/g, "");

async function main() {
  const rows: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let i = 0; ; i += 500) {
    const { data, error } = await sb.from("ai_reply_examples").select("conversation_id, created_at, ai_draft, customer_message, reply_context_snapshot").gte("created_at", FROM).not("reply_context_snapshot", "is", null).order("created_at").range(i, i + 499);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 500) break;
  }
  let n = 0, amtAll = 0, amtCust = 0;
  const byCode: Record<string, number> = {};
  for (const r of rows) {
    if (isTestConversation(r.conversation_id)) continue;
    const pre: string[] = r.reply_context_snapshot?.preRevisionCodes ?? [];
    const fab = pre.filter((c) => /^FABRICATED_(AMOUNT|PROPERTY|AVAILABILITY)/.test(c));
    if (!fab.length) continue;
    n++;
    for (const c of fab) byCode[c] = (byCode[c] ?? 0) + 1;
    const draft = String(r.ai_draft ?? r.reply_context_snapshot?.draftHead ?? "");
    const { data: ms } = await sb.from("messages").select("sender, text").eq("conversation_id", r.conversation_id).lte("created_at", r.created_at).order("created_at", { ascending: false }).limit(20);
    const cust = norm([String(r.customer_message ?? ""), ...((ms ?? []) as Array<{ sender: string; text: string | null }>).filter((m) => m.sender === "customer").map((m) => m.text ?? "")].join("\n"));
    const amts = [...draft.matchAll(AMT)].map((m) => norm(m[0]));
    const inCust = amts.filter((a) => cust.includes(a.replace(/円$/, "")) || cust.includes(a));
    if (fab.some((c) => c.startsWith("FABRICATED_AMOUNT")) && amts.length) { amtAll++; if (inCust.length === amts.length) amtCust++; }
    console.log(`\n${String(r.created_at).slice(0, 16)} ${String(r.conversation_id).slice(0, 8)} [${fab.join(",")}] 下書きの金額 ${amts.join("・") || "なし"}（お客様の発言にある ${inCust.length}）\n  客: ${String(r.customer_message ?? "").replace(/\n/g, " ").slice(0, 120)}\n  案: ${draft.replace(/\n/g, "⏎").slice(0, 200)}`);
  }
  // ② 今の下書きの最終チェック（conversations.ai_draft_check＝引用つき）の FABRICATED_* に出口（isCustomerEchoFabrication）を当て、外れる指摘を全部目で読む
  const { isCustomerEchoFabrication } = await import("../app/lib/fabricated-customer-words");
  let fabN = 0, dropN = 0;
  for (let i = 0; ; i += 500) {
    const { data, error } = await sb.from("conversations").select("id, ai_draft_check").not("ai_draft_check", "is", null).range(i, i + 499);
    if (error) throw new Error(error.message);
    for (const c of data ?? []) {
      if (isTestConversation(c.id)) continue;
      const issues = ((c.ai_draft_check as { issues?: Array<{ code?: string; evidence?: string }> } | null)?.issues ?? []).filter((x) => /^FABRICATED_(AMOUNT|PROPERTY)$/.test(String(x.code)));
      if (!issues.length) continue;
      const { data: ms } = await sb.from("messages").select("sender, text").eq("conversation_id", c.id).order("created_at", { ascending: false }).limit(20);
      const cust = ((ms ?? []) as Array<{ sender: string; text: string | null }>).filter((m) => m.sender === "customer").map((m) => m.text ?? "");
      for (const x of issues) {
        fabN++;
        const d = isCustomerEchoFabrication(String(x.code), x.evidence, cust);
        if (d) dropN++;
        console.log(`② ${d ? "【外す】" : "　残す　"} ${String(c.id).slice(0, 8)} ${x.code}「${String(x.evidence ?? "").slice(0, 60)}」`);
      }
    }
    if (!data || data.length < 500) break;
  }
  console.log(`\n② 今の下書きの FABRICATED_AMOUNT／PROPERTY ${fabN}件 → 出口で外れる ${dropN}件（全部お客様の発言にある物だけのはず・目で読む）`);
  console.log(`\n=== ${FROM}〜: 1回目に FABRICATED_* が付いた回 ${n}（${JSON.stringify(byCode)}）／金額の指摘で下書きの金額が全部お客様の発言にある ${amtCust}/${amtAll}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
