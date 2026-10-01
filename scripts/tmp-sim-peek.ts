import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
(async () => {
  const { data } = await sb.from("messages").select("created_at,sender,is_aix_generated,image_url,line_message_id,text").eq("conversation_id", CONV).order("created_at", { ascending: false }).limit(6);
  for (const m of (data ?? []).reverse()) console.log(m.created_at.slice(11, 19), m.sender, m.is_aix_generated ? "AIX" : "", m.image_url ? "IMG" : "", (m.line_message_id ?? "").slice(0, 12), (m.text ?? "").replace(/\s+/g, " ").slice(0, 160));
  const { data: e } = await sb.from("estimate_records").select("*").eq("conversation_id", CONV).order("created_at", { ascending: false }).limit(2);
  for (const r of e ?? []) console.log("EST", Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== null && !/text|html|body/.test(k)).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 60) : v])));
  const { data: au } = await sb.from("aix_usage_logs").select("*").eq("conversation_id", CONV).order("sent_at", { ascending: false }).limit(1);
  console.log("AIXLOG", JSON.stringify(au?.[0] ?? null).slice(0, 400));
})();
