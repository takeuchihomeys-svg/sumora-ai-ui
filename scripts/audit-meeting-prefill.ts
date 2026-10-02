// scripts/audit-meeting-prefill.ts — 2026-10-02 竹内「内覧日決まったら 1件目の内覧場所を集合場所とする」
//   aix-prefill.meetingPropertyPrefill（待ち合わせの物件＝1件目）を本番の AIX【待ち合わせ】の押下に当て、送った文の物件と比べる（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-meeting-prefill.ts
import { createClient } from "@supabase/supabase-js";
import { meetingPropertyPrefill, propertyBaseName } from "../app/lib/aix-prefill";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
(async () => {
  const { data } = await sb.from("aix_usage_logs").select("conversation_id, created_at, generated_text").eq("aix_type", "meeting_place").neq("conversation_id", "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7").order("created_at", { ascending: false }).limit(200);
  let n = 0, same = 0, diff = 0, none = 0;
  for (const r of data ?? []) {
    const sent = String(r.generated_text ?? "").match(/[0-9]{1,2}[:：][0-9]{2}に\s*([^\n]+?)\s*(?:\n|現地)/)?.[1];
    if (!sent) continue;
    n++;
    const { data: ms } = await sb.from("messages").select("sender, text").eq("conversation_id", r.conversation_id).lt("created_at", r.created_at).order("created_at", { ascending: false }).limit(30);
    const staff = (ms ?? []).filter((m) => m.sender !== "customer").map((m) => m.text ?? "");
    const p = meetingPropertyPrefill(staff);
    if (!p) { none++; continue; }
    const ok = propertyBaseName(sent).includes(propertyBaseName(p.value)) || propertyBaseName(p.value).includes(propertyBaseName(sent));
    if (ok) same++; else { diff++; console.log(`  違う: 先入れ ${p.value}（${p.reason}）／送った ${sent}`); }
  }
  console.log(`AIX【待ち合わせ】${n}: 先入れ 一致 ${same}・違う ${diff}・決まらない ${none}`);
})();
