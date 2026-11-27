/** 1回の steps を相対秒で並べる（読むだけ）。使い方: --ids=1654,1656 [--max=200] */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
(async () => {
  const ids = arg("ids", "").split(",").map(Number).filter(Boolean);
  const max = Number(arg("max", "200"));
  for (const id of ids) {
    const { data } = await sb.from("search_audits").select("id, run_id, created_at, status, trigger, ext_version, cause_key, steps, result, error, intended").eq("id", id).single();
    if (!data) { console.log("無い:", id); continue; }
    const r: any = data;
    console.log(`\n===== #${r.id} ${r.created_at} ver=${r.ext_version} trigger=${r.trigger} status=${r.status} cause=${r.cause_key} error=${String(r.error || "").slice(0, 120)}`);
    const st = (r.steps || []) as { k: string; d?: string; at?: number }[];
    const t0 = st.find((s) => typeof s.at === "number")?.at ?? 0;
    let prev = t0, shown = 0;
    const skip = arg("skip", "") ? new RegExp(arg("skip", "")) : null;
    let hid = 0;
    for (const s of st) {
      if (skip && skip.test(s.k)) { hid++; continue; }
      const at = typeof s.at === "number" ? s.at : prev;
      const rel = Math.round((at - t0) / 1000), gap = Math.round((at - prev) / 1000);
      prev = at;
      if (shown++ >= max) { console.log("  …(省略)"); break; }
      console.log(`  +${String(rel).padStart(5)}s (Δ${String(gap).padStart(4)}) ${s.k} ${String(s.d || "").slice(0, 110)}`);
    }
  }
})();

