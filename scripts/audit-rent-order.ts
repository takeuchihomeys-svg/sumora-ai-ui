// scripts/audit-rent-order.ts — 2026-10-02 ⑫: 顧客の行で家賃の下限＞上限の行を数える（読むだけ・直さない）
// 実行: npx tsx --env-file=.env.local scripts/audit-rent-order.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
(async () => {
  let n = 0; const bad: string[] = [];
  for (let f = 0; f < 50_000; f += 1000) {
    const { data, error } = await sb.from("property_customers").select("id, customer_name, rent_min, rent_max, additional_conditions, updated_at").range(f, f + 999);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ id: string; rent_min: number | null; rent_max: number | null; additional_conditions: string | null; updated_at: string }>) {
      n++;
      if (r.rent_min && r.rent_max && r.rent_min > r.rent_max) bad.push(`${r.id.slice(0, 8)} ${r.rent_min}＞${r.rent_max} 更新 ${r.updated_at.slice(0, 10)}｜${(r.additional_conditions ?? "").split("\n").slice(-2).join(" / ").slice(0, 100)}`);
    }
    if ((data ?? []).length < 1000) break;
  }
  console.log(`顧客の行 ${n}・下限＞上限 ${bad.length}`); for (const b of bad) console.log("  " + b);
})();
