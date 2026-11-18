/**
 * 沿線・駅外しの計測土台だけを出す（2026-11-17 統括Pro）
 *
 *   npx tsx --env-file=.env.local scripts/station-clear-foundation.ts
 *
 * F14 / F23 / F24 / F25 と、監査キー・ops was の内訳。
 */
import { createClient } from "@supabase/supabase-js";
import { auditLearnFoundations, formatFoundationAudit } from "../app/lib/learn-foundation-audit";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

void (async () => {
  const a = await auditLearnFoundations(sb);
  const focus = a.items.filter((x) =>
    /F14_station|F23_station|F24_station|F25_station/.test(x.id),
  );
  console.log("■ 駅・沿線外し土台（焦点）");
  for (const f of focus) {
    console.log(`  ${f.ok ? "✓" : "✗"} ${f.id}: ${f.line}`);
    if (!f.ok) console.log(`     → [${f.layer}] ${f.next}`);
  }
  console.log("");
  for (const line of formatFoundationAudit(a)) console.log(line);
})();
