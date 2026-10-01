// tmp: YUMA に AIX の記録（property_send・first_pickup_id）を1行入れる／--delete=<id> で消す
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const del = process.argv.find((a) => a.startsWith("--delete="))?.slice(9);
  if (del) { const { error } = await sb.from("aix_usage_logs").delete().eq("id", del); console.log("deleted", del, error?.message ?? "ok"); return; }
  const first = Number(process.argv.find((a) => a.startsWith("--first="))?.slice(8));
  const { data, error } = await sb.from("aix_usage_logs").insert({ conversation_id: "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7", aix_type: "property_send", sent_at: new Date().toISOString(), picker_choices: { first_pickup_id: first, image_count: 3 }, generated_text: "tmp test (closing v2)" }).select("id").single();
  console.log(error ? error.message : `inserted ${(data as { id: string }).id}`);
}
main();
