import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const START = process.argv[2];
async function main() {
  const { data } = await sb.from("property_pickups").select("id, sent_at").in("id", [2675, 2676, 2678]);
  console.log(data);
  const { data: lg } = await sb.from("aix_usage_logs").select("id").eq("conversation_id", "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7").eq("generated_text", "tmp test (closing v2)");
  console.log("test logs left", lg?.length);
  const { data: gl, count } = await sb.from("aix_generate_log").select("id, action_type, created_at", { count: "exact" }).eq("conversation_id", "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7").gte("created_at", START);
  console.log("aix_generate_log YUMA since", START, count, [...new Set((gl ?? []).map((g) => g.action_type))]);
  if (process.argv.includes("--delete") && gl?.length) { const { error } = await sb.from("aix_generate_log").delete().in("id", gl.map((g) => g.id)); console.log("deleted", gl.length, error?.message ?? "ok"); }
}
main();
