import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
const SINCE = "2026-09-26T16:50:00Z";
(async () => {
  const { data: cmds } = await sb.from("automation_commands").select("*").contains("customer_ids", [PC]).gte("created_at", SINCE).order("created_at");
  for (const c of cmds ?? []) console.log("CMD", c.id.slice(0, 8), c.status, c.sites, JSON.stringify(c.payload).slice(0, 120), (c as any).error ?? (c as any).error_message ?? "", JSON.stringify((c as any).result ?? (c as any).progress ?? "").slice(0, 150));
  const { data: pk } = await sb.from("property_pickups").select("*").eq("property_customer_id", PC).gte("created_at", SINCE).order("created_at");
  console.log("PICKUPS", pk?.length);
  for (const p of pk ?? []) console.log(" ", p.id, p.site, p.search_mode, p.verdict, p.score, String(p.property_name).slice(0, 20), p.room_no, String(p.batch_id).slice(-18));
  const { data: au } = await sb.from("search_audits").select("*").gte("created_at", SINCE).order("created_at").limit(10);
  for (const a of au ?? []) console.log("AUDIT", a.site, a.status, a.severity, String(a.summary ?? "").slice(0, 100));
})();
