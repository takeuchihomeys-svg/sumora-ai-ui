import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const { data, error } = await sb.from("llm_usage_logs").select("*").gte("created_at", process.argv[2]).limit(200);
  if (error) { console.log(error.message); return; }
  const m = new Map<string, number>();
  for (const r of data ?? []) { const k = `${r.action ?? r.route ?? r.purpose ?? "?"} | ${r.model}`; m.set(k, (m.get(k) ?? 0) + 1); }
  console.log([...m.entries()]);
}
main();
