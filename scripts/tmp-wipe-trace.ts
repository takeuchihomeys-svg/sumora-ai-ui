/**
 * 束の solid 推移を見る（消えた瞬間を特定）
 * npx tsx --env-file=.env.local scripts/tmp-wipe-trace.ts
 */
import { createClient } from "@supabase/supabase-js";
import { countLearnedSolid, hasStationTransitSteps } from "../app/lib/learn-bundle-preserve";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

(async () => {
  const { data } = await sb
    .from("human_learn_profile")
    .select("id,created_at,source_rows,bundle")
    .eq("scope", "all")
    .order("created_at", { ascending: false })
    .limit(15);
  for (const r of data || []) {
    const c = countLearnedSolid(r.bundle);
    const fa = !!(r.bundle as { foundation_audit?: unknown } | null)?.foundation_audit;
    const tr = hasStationTransitSteps(r.bundle);
    const preserved = !!(r.bundle as { shots?: { preserved_learned?: boolean } } | null)?.shots?.preserved_learned;
    console.log(
      r.created_at,
      "id=" + r.id,
      "rows=" + r.source_rows,
      "solid=" + c.solid,
      "fa=" + fa,
      "transit=" + tr,
      preserved ? "preserved" : "",
    );
  }
})();
