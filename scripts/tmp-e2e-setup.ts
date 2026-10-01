// 2026-09-27 YUMA の実機テスト用（テスト後に消す）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
(async () => {
  const { data: c, error } = await sb.from("property_customers").insert({
    customer_name: "YUMAテスト（検索確認）", account: "sumora", status: "active",
    desired_area: "大阪市大正区、大阪市西区", floor_plan: "1K、1DK", rent_max: 75000, walk_minutes: 10, building_age: 30,
    preferences: "バストイレ別", move_in_time: "2か月以内",
  }).select("id").single();
  if (error || !c) { console.log("作れない:", error?.message); return; }
  const { error: e2 } = await sb.from("conversations").update({ property_customer_id: c.id }).eq("id", YUMA);
  console.log("テスト顧客:", c.id, e2 ? e2.message : "YUMA に紐付けOK");
})();
