// scripts/audit-brain-rereads.ts — 同じお客様の番（analyzed_msg_ts が同じ）をブレインが何回読み直し、結果（AIX・返信か）が変わったかを数える（読むだけ・LLM なし）
//   呼び出しの道（webhook・下書き・送った後・sweep）は、判断の記録の時刻に一番近い llm_usage_logs の brain_* の route で付ける。
// 使い方: npx tsx --env-file=.env.local scripts/audit-brain-rereads.ts [--days=14]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 14);
const short = (r: string | null) => (r ?? "-").replace("/api/", "").replace("generate-draft-bg-async", "下書き").replace("line-webhook", "受信").replace("send-line-message", "送った後").replace("cron/brain-sweep", "sweep").replace("cron/generate-pending-drafts", "下書きcron").replace("generate-reply", "書く役");
(async () => {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const logs: Array<{ conversation_id: string; created_at: string; suggested_action: string | null; suggested_reply_mode: string | null; analyzed_msg_ts: string | null; source: string | null }> = [];
  for (let off = 0; ; off += 1000) { const { data } = await sb.from("brain_decision_logs").select("conversation_id, created_at, suggested_action, suggested_reply_mode, analyzed_msg_ts, source").gte("created_at", since).order("created_at").range(off, off + 999); logs.push(...((data ?? []) as typeof logs)); if (!data || data.length < 1000) break; }
  const usage: Array<{ conversation_id: string | null; route: string | null; created_at: string; input_uncached: number | null; cache_read: number | null; cache_write: number | null; output_tokens: number | null }> = [];
  for (let off = 0; ; off += 1000) { const { data } = await sb.from("llm_usage_logs").select("conversation_id, route, created_at, input_uncached, cache_read, cache_write, output_tokens").gte("created_at", since).eq("action", "brain_fresh").eq("env", "production").range(off, off + 999); usage.push(...((data ?? []) as typeof usage)); if (!data || data.length < 1000) break; }
  const usd = (u: (typeof usage)[number]) => ((u.input_uncached ?? 0) * 3 + (u.cache_read ?? 0) * 0.3 + (u.cache_write ?? 0) * 3.75 + (u.output_tokens ?? 0) * 15) / 1e6;
  const byKey = new Map<string, typeof logs>();
  for (const l of logs) { if (!l.analyzed_msg_ts) continue; const k = `${l.conversation_id}|${l.analyzed_msg_ts}`; const a = byKey.get(k) ?? []; a.push(l); byKey.set(k, a); }
  let turns = 0, reads = 0, rereads = 0, same = 0;
  const byRoute: Record<string, { n: number; same: number; usd: number }> = {};
  for (const arr of byKey.values()) {
    turns++; reads += arr.length;
    for (let i = 1; i < arr.length; i++) {
      rereads++;
      const unchanged = (arr[i].suggested_action ?? "") === (arr[i - 1].suggested_action ?? "") && (arr[i].suggested_reply_mode ?? "") === (arr[i - 1].suggested_reply_mode ?? "");
      if (unchanged) same++;
      const t = Date.parse(arr[i].created_at);
      const u = usage.filter((x) => x.conversation_id === arr[i].conversation_id && Math.abs(Date.parse(x.created_at) - t) < 120_000).sort((a, b) => Math.abs(Date.parse(a.created_at) - t) - Math.abs(Date.parse(b.created_at) - t))[0];
      const r = short(u?.route ?? null);
      const s = (byRoute[r] ??= { n: 0, same: 0, usd: 0 }); s.n++; if (unchanged) s.same++; s.usd += u ? usd(u) : 0;
    }
  }
  console.log(`直近${days}日: 判断の記録 ${logs.length}・番（同じ analyzed_msg_ts） ${turns}・読んだ ${reads}回（1番 ${(reads / turns).toFixed(2)}）・読み直し ${rereads}回・うち結果が同じ ${same}回（${Math.round((same / Math.max(1, rereads)) * 100)}%）`);
  console.log("読み直しの道ごと（回数・結果が同じ・費用 brain_fresh のおおよそ）:");
  for (const [k, v] of Object.entries(byRoute).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(12)} ${String(v.n).padStart(4)}回  同じ ${v.same}（${Math.round((v.same / v.n) * 100)}%）  $${v.usd.toFixed(2)}`);
})();
