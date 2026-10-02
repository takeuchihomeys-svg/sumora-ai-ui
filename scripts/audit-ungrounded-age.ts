// scripts/audit-ungrounded-age.ts — 2026-10-02 ⑫ 21巡: staff-confirm-facts.findUngroundedAgeRange の線（読むだけ・LLM なし）
//   AI の下書き（ai_reply_examples.ai_draft）で当たる数と、スタッフが送った文にその幅が残ったか／人の送信（365日）で築年数の幅を書いた数（参考）
// 実行: npx tsx --env-file=.env.local scripts/audit-ungrounded-age.ts
import { createClient } from "@supabase/supabase-js";
import { findUngroundedAgeRange } from "../app/lib/staff-confirm-facts";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
(async () => {
  const { data } = await sb.from("ai_reply_examples").select("ai_draft, sent_reply, customer_message").not("ai_draft", "is", null).order("created_at", { ascending: false }).limit(1000);
  let n = 0, hit = 0, kept = 0;
  for (const r of data ?? []) { n++; const h = findUngroundedAgeRange(String(r.ai_draft), String(r.customer_message ?? "")); if (!h) continue; hit++; const k = String(r.sent_reply ?? "").includes(h.range.split("〜")[0]); if (k) kept++; console.log(`  ${k ? "残" : "消"} ${h.text.slice(0, 90)}`); }
  console.log(`AI の下書き ${n}: 当たる ${hit}（送った文に数が残った ${kept}）`);
  const { data: st } = await sb.from("messages").select("text").neq("sender", "customer").ilike("text", "%築%年%").limit(1000);
  let sh = 0; for (const m of st ?? []) { const h = findUngroundedAgeRange(String(m.text), ""); if (h) { sh++; if (sh <= 8) console.log(`  人: ${h.text.slice(0, 90)}`); } }
  console.log(`人の送信（築・年を含む ${st?.length}）で幅を書いた ${sh}（参考: 人は物件を見て書く）`);
})();
