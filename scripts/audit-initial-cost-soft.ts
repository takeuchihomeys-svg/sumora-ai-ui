// 初期費用の希望の「できれば」（detectLowInitialCostSoft）を全お客様の条件に当てる監査（読み取りのみ）
// 2026-10-01 竹内（チンシャン「初期費用は安いと嬉しい」で保留だらけ）。できればに変わる人の節を目で読む
// 実行: npx tsx --env-file=.env.local scripts/audit-initial-cost-soft.ts
import { createClient } from "@supabase/supabase-js";
import { detectLowInitialCostSoft, detectWantsLowInitialCost } from "../app/lib/property-brain";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
(async () => {
  const { data, error } = await sb.from("property_customers").select("id, customer_name, preferences, other_requests, ng_points, additional_conditions, initial_cost_limit").limit(2000);
  if (error) throw new Error(error.message);
  let want = 0, soft = 0;
  const RE = /[^\n。、,，/／・]{0,20}(?:初期費用|敷金|礼金|敷礼|ゼロゼロ)[^\n。、,，/／・]{0,20}/g;
  for (const c of data ?? []) {
    if (!detectWantsLowInitialCost(c)) continue;
    want++;
    if (!detectLowInitialCostSoft(c)) continue;
    soft++;
    const txt = [c.preferences, c.other_requests, c.ng_points, c.additional_conditions].filter(Boolean).join(" ｜ ");
    console.log(`- ${(txt.match(RE) ?? []).slice(0, 3).join(" ／ ")}`);
  }
  console.log(`\nお客様 ${data?.length}人・初期費用の希望あり ${want}人・うち「できれば」 ${soft}人`);
})();
