// scripts/audit-co-resident.ts — 申込フォーマットの実送信を「同居人記入欄あり／なし」で分け、その前の会話・条件から co-resident.detectCoResident で当てる（読むだけ・LLM なし）
// 2026-10-02 竹内さんの決定「申込へのフォーマットは同居人の有無で形が違う。会話・条件から判断・分からなければ選ばずスタッフに選ばせる」
//   ※ 申込の書類の中身（氏名・生年月日等）は読まない・出さない。数えるのはフォーマットの見出し（【同居人記入欄】の有無）とその前のお客様の発言の手がかりの語だけ。
// 実行: npx tsx --env-file=.env.local scripts/audit-co-resident.ts [--days=365] [--show]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { detectCoResidentWithOccupants } from "../app/lib/co-resident";
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "365");
const SHOW = process.argv.includes("--show");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const sends = (await sb.from("messages").select("conversation_id, created_at, text").neq("sender", "customer").gte("created_at", since).ilike("text", "%【お申込者様記入欄】%").order("created_at")).data ?? [];
  const convPc = new Map<string, string | null>();
  const seen = new Set<string>();
  const cell = new Map<string, number>();
  let n = 0;
  for (const s of sends as Array<{ conversation_id: string; created_at: string; text: string }>) {
    if (isTestConversation(s.conversation_id) || seen.has(s.conversation_id)) continue;
    seen.add(s.conversation_id); // 会話ごとに最初のフォーマットだけ
    n++;
    const actual = /【同居人記入欄】/.test(s.text) ? "shared" : "single";
    const cust = ((await sb.from("messages").select("text, created_at").eq("conversation_id", s.conversation_id).eq("sender", "customer").lt("created_at", s.created_at).order("created_at").limit(400)).data ?? []).map((m) => m.text ?? "");
    if (!convPc.has(s.conversation_id)) convPc.set(s.conversation_id, ((await sb.from("conversations").select("property_customer_id").eq("id", s.conversation_id).maybeSingle()).data?.property_customer_id as string | null) ?? null);
    const pcid = convPc.get(s.conversation_id);
    const pc = pcid ? (await sb.from("property_customers").select("preferences, other_requests, ng_points, occupants").eq("id", pcid).maybeSingle()).data : null;
    const v = detectCoResidentWithOccupants(cust, pc ? [pc.preferences, pc.other_requests] : [], (pc as { occupants?: number | null } | null)?.occupants ?? null);
    const k = `実際=${actual === "shared" ? "同居あり" : "単独"}・判定=${v.value === "shared" ? "同居あり" : v.value === "single" ? "単独" : "分からない"}`;
    cell.set(k, (cell.get(k) ?? 0) + 1);
    if (SHOW && (v.value !== actual)) console.log(`  ${s.conversation_id.slice(0, 8)} ${s.created_at.slice(0, 10)} ${k}｜手がかり: ${v.evidence ?? "なし"}`);
  }
  console.log(`\n申込フォーマットの実送信（会話ごとに最初・${DAYS}日）: ${n}会話`);
  for (const [k, v] of [...cell].sort()) console.log(`  ${k}: ${v}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
