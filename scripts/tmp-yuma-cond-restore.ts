// tmp: YUMA 条件入口テストの後片付け（写しに戻す・テストの発言と条件の履歴を消す）
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7", PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
/* eslint-disable @typescript-eslint/no-explicit-any */
async function main() {
  const snap = JSON.parse(readFileSync(process.env.SNAP_FILE ?? "", "utf8"));
  const at: string = snap.at;
  const { id: _i, created_at: _c, ...pc } = snap.pc as Record<string, any>;
  void _i; void _c;
  const r1 = await sb.from("property_customers").update(pc).eq("id", PC);
  console.log("property_customers:", r1.error?.message ?? "戻した");
  const { id: _j, created_at: _d, ...conv } = snap.conv as Record<string, any>;
  void _j; void _d;
  const r2 = await sb.from("conversations").update(conv).eq("id", Y);
  console.log("conversations:", r2.error?.message ?? "戻した");
  const r3 = await sb.from("messages").delete().eq("conversation_id", Y).gt("created_at", at).select("id");
  console.log("messages 消した:", r3.error?.message ?? r3.data?.length);
  const r4 = await sb.from("property_condition_history").delete().eq("property_customer_id", PC).gt("created_at", at).select("id");
  console.log("property_condition_history 消した:", r4.error?.message ?? r4.data?.length);
}
main().catch((e) => { console.error(e); process.exit(1); });
