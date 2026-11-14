// scripts/audit-screening-risk-here.ts — 読むだけ・LLM なし（2026-11-15 作業員H）
//   審査の相談の網（screeningRiskHereTurn・SCREENING_RISK_HERE_PHONE）を本番のお客様の通（「審査」を含む・直近 N 日）に当て、
//   掛かった通と、その後のスタッフの最初の一手・6時間以内の AIX を並べる（電話にしていない番に掛かっていないかを目で読む）。
//   使い方: npx tsx --env-file=<.env.local> scripts/audit-screening-risk-here.ts [--days=120]
import { createClient } from "@supabase/supabase-js";
import { screeningRiskHereTurn, screeningConsultTurn } from "../app/lib/screening-phone-material";
import { isTestConversation } from "../app/lib/test-conversations";
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "120");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Array<{ conversation_id: string; created_at: string; text: string }> = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, created_at, text").eq("sender", "customer").gte("created_at", since).ilike("text", "%審査%").order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows)); if ((data ?? []).length < 1000) break;
  }
  let n = 0, hit = 0;
  for (const r of rows) {
    if (isTestConversation(r.conversation_id)) continue; n++;
    if (!screeningRiskHereTurn(r.text)) continue; hit++;
    const end = new Date(Date.parse(r.created_at) + 6 * 3_600_000).toISOString();
    const { data: s } = await sb.from("messages").select("staff_writer, is_aix_generated, created_at").eq("conversation_id", r.conversation_id).neq("sender", "customer").gt("created_at", r.created_at).order("created_at").limit(1);
    const { data: a } = await sb.from("aix_usage_logs").select("aix_type").eq("conversation_id", r.conversation_id).gte("created_at", r.created_at).lte("created_at", end);
    const f = (s ?? [])[0] as { staff_writer?: string; is_aix_generated?: boolean } | undefined;
    console.log(`${r.conversation_id.slice(0, 8)} ${r.created_at.slice(5, 16)} 既存の網=${screeningConsultTurn(r.text)} 最初=${f ? `${f.staff_writer}:${f.is_aix_generated ? "AIX" : "返信"}` : "なし"} AIX6h=${((a ?? []) as Array<{ aix_type: string }>).map((x) => x.aix_type).join(",") || "-"}\n   ${r.text.replace(/\s+/g, " ").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "＜番号＞").slice(0, 120)}`);
  }
  console.log(`「審査」を含むお客様の通 ${n}・網に掛かった ${hit}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
