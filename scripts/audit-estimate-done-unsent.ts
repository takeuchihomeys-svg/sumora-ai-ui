// scripts/audit-estimate-done-unsent.ts — 「済みなのに見積を送っていない見積の予定」の数（読むだけ・LLM なし・費用0）
//
// 2026-11-22 作業員K2（台帳 #580・ESTIMATE_EVENT_GUARD の確かめ・on の後に 0 へ向かうか）。
//   見積の予定（calendar_events.event_type=estimate_sheet・is_done）のうち、予定の前3日〜後2日に
//   見積を送った印（estimate_records の行・見積書の AIX・AIX の同封の印 estimate_sent）が1つも無い物を、会話ごとに数える。
//   申込以降の会話（conversations.status が applying 以降）とテストの会話は外す。同じ会話・同じ時刻の重複も数える。会話は頭8字だけ。
// 実行: npx tsx --env-file=.env.local scripts/audit-estimate-done-unsent.ts [--days=30] [--show]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";
import { duplicateEstimateEventIds } from "../app/lib/estimate-event-guard";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const POST = new Set(["applying", "contract", "won", "screening", "approved", "contracted"]);
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "30")) || 30;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: ev, error } = await sb.from("calendar_events").select("id, conversation_id, start_at, created_at, notes, is_done, event_type").eq("event_type", "estimate_sheet").gte("start_at", since).limit(3000);
  if (error) throw new Error(error.message);
  const rows = ((ev ?? []) as Array<{ id: string; conversation_id: string | null; start_at: string; created_at: string; notes: string | null; is_done: boolean }>)
    .filter((r) => r.conversation_id && !isTestConversation(r.conversation_id) && !isNoLineTestConversation(r.conversation_id));
  const convs = [...new Set(rows.map((r) => r.conversation_id!))];
  const status = new Map<string, string | null>();
  for (let i = 0; i < convs.length; i += 100) { const { data } = await sb.from("conversations").select("id, status").in("id", convs.slice(i, i + 100)); for (const c of (data ?? []) as Array<{ id: string; status: string | null }>) status.set(c.id, c.status); }
  let done = 0, unsent = 0; const unsentConvs = new Set<string>();
  for (const r of rows.filter((x) => x.is_done)) {
    if (POST.has(String(status.get(r.conversation_id!) ?? ""))) continue;
    done++;
    const a = new Date(Date.parse(r.start_at) - 3 * 864e5).toISOString(), b = new Date(Date.parse(r.start_at) + 2 * 864e5).toISOString();
    const [rec, aix] = await Promise.all([
      sb.from("estimate_records").select("id", { count: "exact", head: true }).eq("conversation_id", r.conversation_id!).gte("created_at", a).lte("created_at", b),
      sb.from("aix_usage_logs").select("id", { count: "exact", head: true }).eq("conversation_id", r.conversation_id!).gte("sent_at", a).lte("sent_at", b).or("aix_type.eq.estimate_sheet,estimate_sent.eq.true"),
    ]);
    if (!(rec.count ?? 0) && !(aix.count ?? 0)) { unsent++; unsentConvs.add(r.conversation_id!); }
  }
  const dups = duplicateEstimateEventIds(rows.map((r) => ({ ...r, is_done: false })));
  console.log(`見積の予定（${days}日・申込以降とテストを外す）: 済み ${done}・済みなのに見積を送っていない ${unsent}（${unsentConvs.size}会話）・同じ会話・同じ時刻の重複 ${dups.length}`);
  if (process.argv.includes("--show")) console.log("  会話:", [...unsentConvs].map((c) => c.slice(0, 8)).join("・"));
})().catch((e) => { console.error(e); process.exit(1); });
