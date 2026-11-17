import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

async function main() {
  const since = "2026-11-16T07:00:00Z";
  const { data, error } = await sb
    .from("search_audits")
    .select("created_at,property_customer_id,status,mode,cause_key,ext_version,steps")
    .gte("created_at", since)
    .in("mode", ["brain_aix", "aix", "brain_normal"])
    .order("created_at", { ascending: true })
    .limit(50);
  console.log("err", error?.message || null, "n", data?.length);
  const cids = [...new Set((data || []).map((x) => x.property_customer_id).filter(Boolean))];
  const { data: custs } = await sb.from("property_customers").select("id,customer_name").in("id", cids);
  const nameOf = Object.fromEntries((custs || []).map((c) => [c.id, c.customer_name]));

  let prev: string | null = null;
  for (const a of data || []) {
    const name = nameOf[a.property_customer_id] || "?";
    const steps = Array.isArray(a.steps) ? a.steps.map((s: { k?: string }) => s.k).filter(Boolean) : [];
    const keys = steps.filter((k): k is string =>
      typeof k === "string" && /owner_mismatch|switch|batch|fill_done|clear|begin|finish|stall|timeout|place_redo|no_fill/i.test(k),
    );
    const switchGap = prev && prev !== name ? " ←切替" : "";
    console.log(
      a.created_at.slice(11, 19),
      name + switchGap,
      a.mode,
      a.status,
      a.cause_key || "-",
      a.ext_version,
      keys.slice(0, 10).join("|"),
    );
    prev = name;
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
