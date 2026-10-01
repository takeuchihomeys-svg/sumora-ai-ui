import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
(async () => {
  const { data: m } = await sb.from("messages").select("sender,text,created_at,quoted_message_id").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(4);
  for (const x of (m ?? []).reverse()) console.log("MSG", x.created_at.slice(11, 19), x.sender, x.quoted_message_id ? "(引用)" : "", String(x.text).slice(0, 70).replace(/\n/g, " / "));
  const { data: c } = await sb.from("conversations").select("status,brain_analyzed_at,suggested_aix_meta,ai_draft,ai_draft_check").eq("id", Y).single();
  const meta = (c as any)?.suggested_aix_meta ?? {};
  console.log("STATUS", (c as any)?.status, "brain_at", (c as any)?.brain_analyzed_at);
  console.log("AIX", JSON.stringify({ action: meta.action ?? meta.aix, reply_mode: meta.reply_mode, dir: meta.reply_direction, alt: meta.alt_actions, parallel: meta.parallel_search }).slice(0, 400));
  console.log("DRAFT", String((c as any)?.ai_draft ?? "").slice(0, 300).replace(/\n/g, " / "));
  const { getCustomerState } = await import("../app/lib/customer-state-server");
  const s: any = await getCustomerState(Y);
  console.log("STATE", s?.headline, "| stage", s?.stage, "| focus", s?.focusKey, "| warn", (s?.conflicts ?? []).filter((x: any) => x.severity === "warn").map((x: any) => x.code));
})();
