// tmp: YUMA 条件入口テストの写し（save|diff）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync } from "node:fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7", PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
const FILE = process.env.SNAP_FILE!;
async function main() {
  const { data: conv } = await sb.from("conversations").select("*").eq("id", Y).single();
  const { data: pc } = await sb.from("property_customers").select("*").eq("id", PC).single();
  const { data: tasks } = await sb.from("line_tasks").select("id,status").eq("conversation_id", Y).eq("status", "pending");
  const { data: aix } = await sb.from("aix_action_items").select("*").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(20);
  const { data: hist } = await sb.from("property_condition_history").select("id,created_at").eq("customer_id", PC).order("created_at", { ascending: false }).limit(1);
  const snap = { at: new Date().toISOString(), conv, pc, tasks, aix, hist };
  writeFileSync(FILE, JSON.stringify(snap, null, 2));
  console.log("saved", FILE, "tasks", tasks?.length, "aix", aix?.length, "hist", JSON.stringify(hist));
}
main();
