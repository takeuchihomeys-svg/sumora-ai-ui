// scripts/tmp-check.ts（調べるだけ）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
);
async function main() {
  const now = Date.now();
  const { data: c } = await sb.from("automation_commands")
    .select("id,status,picked_ext_version,error_message,created_at").eq("id", "7e4ded4a-a7e8-4dd1-a4fd-a32eb790ea28").maybeSingle();
  console.log("指示:", JSON.stringify(c));
  const { data: a } = await sb.from("search_audits")
    .select("site,status,ext_version,created_at,cause_key,steps,intended,filled")
    .gte("created_at", new Date(now - 20 * 60_000).toISOString())
    .order("created_at", { ascending: false }).limit(4);
  console.log("検索(20分):", (a ?? []).length);
  for (const r of a ?? []) {
    const st = Array.isArray(r.steps) ? (r.steps as Array<{ k?: string; d?: string }>) : [];
    console.log(`  ${String(r.created_at).slice(11, 19)} ${r.site} ${r.status} v${r.ext_version} ${r.cause_key ?? ""}`);
    if (st.length) console.log(`     ${st.map((s) => s.k).join(",").slice(0, 160)}`);
    const i = r.intended as Record<string, unknown> | null;
    if (i) console.log(`     intended: area_mode=${i.area_mode} stations=${Array.isArray(i.station_names) ? (i.station_names as unknown[]).length : 0} cities=${Array.isArray(i.city_codes) ? (i.city_codes as unknown[]).length : 0}`);
  }
}
main().catch((e) => console.log("THROW", e instanceof Error ? e.message : String(e)));
