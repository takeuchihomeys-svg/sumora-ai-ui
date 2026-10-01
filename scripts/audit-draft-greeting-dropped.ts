// scripts/audit-draft-greeting-dropped.ts
// 2026-10-02 ⑫ 4巡目（再生 first_contact_02・flow4 t01）: 初回の挨拶は resolveGreeting/enforceOpening で決めて付けるが、
//   最終チェックの修正ループ（書き直し）の後に掛け直していないため、書き直しで「はじめまして…鈴木と申します」が落ちた下書きが出る。
//   本番の記録（ai_reply_examples の ai_draft と送った文）で、スタッフが はじめまして で送った初回に AI の下書きが はじめまして を持っていない数を数える。読むだけ・LLM なし。
// 実行: npx tsx --env-file=.env.local scripts/audit-draft-greeting-dropped.ts [--days=120]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=120").slice(7));
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Array<{ conversation_id: string; sent_reply: string | null; ai_draft: string | null; created_at: string; was_ai_used: boolean | null }> = [];
  for (let f = 0; f < 200_000; f += 1000) {
    const { data, error } = await sb.from("ai_reply_examples").select("conversation_id, sent_reply, ai_draft, created_at, was_ai_used").gte("created_at", since).range(f, f + 999);
    if (error) throw error; rows.push(...((data ?? []) as typeof rows)); if ((data ?? []).length < 1000) break;
  }
  let n = 0, dropped = 0;
  const ex: string[] = [];
  for (const r of rows) {
    const s = r.sent_reply ?? "", d = r.ai_draft ?? "";
    if (!d.trim() || !/はじめまして|初めまして/.test(s)) continue;
    n++;
    if (!/はじめまして|初めまして/.test(d)) { dropped++; if (ex.length < 15) ex.push(`${String(r.conversation_id ?? "").slice(0, 8)} ${String(r.created_at ?? "").slice(0, 10)} 下書き: ${d.replace(/\n/g, " / ").slice(0, 90)}`); }
  }
  console.log(`スタッフが はじめまして で送った初回のうち AI の下書きがある ${n}・下書きに はじめまして が無い ${dropped}`);
  for (const e of ex) console.log("  " + e);
})();
