import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88", SINCE = "2026-09-26T16:50:00Z";
(async () => {
  const { data: cmds } = await sb.from("automation_commands").select("*").contains("customer_ids", [PC]).gte("created_at", SINCE).order("created_at");
  for (const c of cmds ?? []) console.log("CMD", c.id.slice(0, 8), c.status, JSON.stringify(c.payload).slice(0, 100));
  const { data: pk } = await sb.from("property_pickups").select("id,complete_group_id,recommended,status,room_no,summary_text").eq("property_customer_id", PC).gte("created_at", SINCE);
  const groups = new Set((pk ?? []).map((p) => p.complete_group_id)); console.log("PICKUPS", pk?.length, "groups", [...groups]);
  console.log("crown", (pk ?? []).filter((p) => (p as any).recommended).map((p) => p.id));
  const noRoom = (pk ?? []).filter((p) => !p.room_no).slice(0, 2); for (const p of noRoom) console.log("NOROOM", p.id, String(p.summary_text).slice(0, 120).replace(/\n/g, " | "));
  const { data: gr } = await sb.from("property_pickup_completions").select("*").gte("created_at", SINCE).limit(5); for (const g of gr ?? []) console.log("GROUP", JSON.stringify(g).slice(0, 300));
  const { data: au } = await sb.from("search_audits").select("*").gte("created_at", SINCE).order("created_at"); for (const a of au ?? []) console.log("AUDIT", a.site, a.status, a.severity, JSON.stringify(a).slice(0, 250));
})();
