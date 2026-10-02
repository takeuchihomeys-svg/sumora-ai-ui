// scripts/audit-phone-promise-draft.ts
// 2026-10-02 ⑫ 19巡: 下書きが「今お電話いたします」等のこちらから電話をかける約束を書いた時に自動で送らない線（staff-confirm-facts の phone_call_promise）。読むだけ・LLM なし。
//   AI の下書き（ai_reply_examples・120日）で当たる数と、スタッフが送った文にその約束が残ったか（残った＝スタッフも電話するつもりだった）
// 実行: npx tsx --env-file=.env.local scripts/audit-phone-promise-draft.ts [--days=120]
import { createClient } from "@supabase/supabase-js";
import { PHONE_CALL_PROMISE_RE } from "../app/lib/staff-confirm-facts";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=120").slice(7));
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data } = await sb.from("ai_reply_examples").select("ai_draft, sent_reply").gte("created_at", since).not("ai_draft", "is", null).limit(20000);
  let n = 0, hit = 0, kept = 0;
  for (const r of data ?? []) {
    n++;
    const d = String(r.ai_draft ?? "");
    const line = d.split(/\n+/).find((l) => PHONE_CALL_PROMISE_RE.test(l));
    if (!line) continue;
    hit++;
    const s = String(r.sent_reply ?? "");
    const k = PHONE_CALL_PROMISE_RE.test(s); if (k) kept++;
    console.log(`${k ? "残" : "消"} 案: ${line.slice(0, 80)}\n     送: ${s.replace(/\n/g, " / ").slice(0, 110)}`);
  }
  const { count } = await sb.from("messages").select("id", { count: "exact", head: true }).eq("sender", "staff").gte("created_at", since);
  console.log(`AI の下書き ${n}: 当たる ${hit}（送った文に約束が残った ${kept}）・参考 スタッフの送信 ${count}`);
})();
