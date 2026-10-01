// scripts/audit-hearing-prefill.ts — 条件ヒアリングのフォームに「お客様の発言から書き入れる値」（hearing-form.hearingKnownFromCustomerTexts）を、
//   実際にスタッフがヒアリングを送った時点の会話に当てて目で読む（読むだけ・LLM なし）。2026-10-02 竹内さん「もらっている条件は項目に入れる」
//   ※ 申込の書類の後の会話は対象外（ヒアリングの時点＝初期の会話だけ）。出すのは切り出した値だけ。
// 実行: npx tsx --env-file=.env.local scripts/audit-hearing-prefill.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { hearingKnownFromCustomerTexts, hearingValues } from "../app/lib/hearing-form";
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "180");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const a = (await sb.from("aix_usage_logs").select("conversation_id, created_at").eq("aix_type", "condition_hearing").gte("created_at", since)).data ?? [];
  const b = (await sb.from("messages").select("conversation_id, created_at").neq("sender", "customer").gte("created_at", since).ilike("text", "%ご希望のお部屋探しご条件%")).data ?? [];
  const first = new Map<string, string>();
  for (const r of [...a, ...b].sort((x, y) => x.created_at.localeCompare(y.created_at))) if (!isTestConversation(r.conversation_id) && !first.has(r.conversation_id)) first.set(r.conversation_id, r.created_at);
  let n = 0, any = 0; const cnt: Record<string, number> = {};
  for (const [cid, at] of first) {
    const cust = ((await sb.from("messages").select("text").eq("conversation_id", cid).eq("sender", "customer").lt("created_at", at).order("created_at").limit(30)).data ?? []).map((m) => m.text ?? "");
    n++;
    const v = hearingValues(hearingKnownFromCustomerTexts(cust));
    const filled = Object.entries(v).filter(([, x]) => x);
    if (filled.length) any++;
    for (const [k] of filled) cnt[k] = (cnt[k] ?? 0) + 1;
    console.log(`${cid.slice(0, 8)} ${at.slice(0, 10)}｜${filled.map(([k, x]) => `${k}=${x}`).join(" ／ ") || "（なし）"}｜C: ${cust.filter((t) => !/^\[画像\]/.test(t)).join(" ").replace(/\n/g, " ").slice(0, 120)}`);
  }
  console.log(`\nヒアリングの時点 ${n}会話: 発言から1つ以上書き入れる ${any}・項目別 ${JSON.stringify(cnt)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
