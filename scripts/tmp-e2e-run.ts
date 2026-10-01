// 2026-09-27 YUMA 実機テスト: 画面の一括検索と同じ関数で web_brain の指示を1件積む（テスト後に消す）
import { createClient } from "@supabase/supabase-js";
import { buildWebBrainCommands } from "../app/lib/web-brain-search";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
(async () => {
  const { data: pc } = await sb.from("property_customers").select("id, rp_update_days, last_property_sent_at, property_viewed_at").eq("id", PC).single();
  const { rows } = buildWebBrainCommands([pc as never], "realnetpro" as never, false, {});
  const { data, error } = await sb.from("automation_commands").insert(rows).select("id, status, payload, sites, created_at");
  console.log(error ? error.message : JSON.stringify(data));
})();
