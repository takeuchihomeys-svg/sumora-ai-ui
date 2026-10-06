// scripts/audit-new-build-claim.ts — 「YYYY年M月築の新築」（築年が13か月以上前）を築浅に直す出口（new-build-claim.ts）を過去の文に当てる（読むだけ・LLM なし）
// 2026-10-06 竹内（ゆなまる）「新築とは新築で未入居の場合、新築となる」
//   スタッフの送信（手打ち・AIX）と AI の下書き（aix_generate_log）で、その通の時刻を基準に直る通を全部出す（目で読む）。
//   スタッフの「YYYY年M月築」の言い方の分布も出す（新築／築年数浅く／築浅物件）。
// 実行: npx tsx --env-file=.env.local scripts/audit-new-build-claim.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { fixStaleNewBuildClaim } from "../app/lib/new-build-claim";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "365");

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const sent: Array<{ conversation_id: string; text: string | null; created_at: string; is_aix_generated: boolean | null }> = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, text, created_at, is_aix_generated").eq("sender", "staff").gte("created_at", since).ilike("text", "%新築%").order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    sent.push(...((data ?? []) as typeof sent));
    if (!data || data.length < 1000) break;
  }
  let nS = 0, fixAix = 0, fixHand = 0, keptRecent = 0;
  for (const r of sent) {
    if (isTestConversation(r.conversation_id) || !r.text) continue;
    nS++;
    const f = fixStaleNewBuildClaim(r.text, Date.parse(r.created_at));
    if (/(?:19|20)\d{2}年(?:\d{1,2}月)?築(?:の|で|、)?新築/.test(r.text) && !f.fixed.length) keptRecent++;
    if (!f.fixed.length) continue;
    if (r.is_aix_generated) fixAix++; else fixHand++;
    console.log(`送信 ${r.created_at.slice(0, 10)} ${r.is_aix_generated ? "AIX" : "手"} ${f.fixed.map((x) => `「${x.from}」→「${x.to}」(${x.months}か月)`).join(" ")}`);
  }
  const gens: Array<{ generated_text: string | null; created_at: string; action_type: string; conversation_id: string }> = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("aix_generate_log").select("generated_text, created_at, action_type, conversation_id").gte("created_at", since).ilike("generated_text", "%新築%").order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    gens.push(...((data ?? []) as typeof gens));
    if (!data || data.length < 1000) break;
  }
  let nG = 0, fixG = 0;
  for (const r of gens) {
    if (isTestConversation(r.conversation_id) || !r.generated_text) continue;
    nG++;
    const f = fixStaleNewBuildClaim(r.generated_text, Date.parse(r.created_at));
    if (!f.fixed.length) continue;
    fixG++;
    const i = r.generated_text.indexOf(f.fixed[0].from);
    console.log(`下書き ${r.created_at.slice(0, 10)} ${r.action_type} …${r.generated_text.slice(Math.max(0, i - 20), i + 40).replace(/\n/g, "⏎")}… → ${f.fixed.map((x) => `「${x.to}」(${x.months}か月)`).join(" ")}`);
  }
  console.log(`\nスタッフの送信（新築を含む）${nS}通: 直る AIX ${fixAix}・手打ち ${fixHand}・12か月以内でそのまま ${keptRecent}`);
  console.log(`AI の下書き（新築を含む）${nG}通: 直る ${fixG}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
