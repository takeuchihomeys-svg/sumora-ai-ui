import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const s = JSON.parse(readFileSync("C:/Users/竹内悠~1/AppData/Local/Temp/claude/c--Users-------sumora-ai-ui/90d5437f-9ec8-479d-94e9-1097dde86432/scratchpad/viewing-live-snap.json", "utf8")) as { pc: Record<string, unknown> };
(async () => { const { error } = await sb.from("property_customers").update({ ai_summary: s.pc.ai_summary, ai_summary_at: s.pc.ai_summary_at, ai_summary_json: s.pc.ai_summary_json }).eq("id", "509cd061-60cc-49a9-8c5a-4f356c4a5f88");
console.log(error?.message ?? "ai_summary 系を戻した"); })();
