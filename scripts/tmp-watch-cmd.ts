// tmp: 命令の状態を見張る（変わった時だけ1行）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const ID = process.argv[2]; const PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
let prev = "";
async function tick() {
  const { data } = await sb.from("automation_commands").select("status,picked_up_at,picked_ext_version,picked_install_id,processed_customers,error_message").eq("id", ID).single();
  const { data: a } = await sb.from("search_audits").select("site,status,trigger").eq("property_customer_id", PC).gte("created_at", new Date(Date.now() - 3600e3).toISOString()).order("created_at");
  const s = `${data?.status} v=${data?.picked_ext_version} inst=${String(data?.picked_install_id ?? "").slice(0, 8)} err=${(data?.error_message ?? "").slice(0, 120)} audits=${(a ?? []).map((x) => `${x.site}:${x.status}:${x.trigger}`).join(",")}`;
  if (s !== prev) { console.log(new Date().toLocaleTimeString("ja-JP"), s); prev = s; }
  return data?.status === "done" || data?.status === "error";
}
(async () => { for (;;) { try { if (await tick()) break; } catch (e) { console.log("err", String(e)); } await new Promise((r) => setTimeout(r, 30000)); } })();
