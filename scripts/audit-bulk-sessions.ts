/** bulk_manual を時系列で並べ、何人目まで進んだか・どこで終わったか（読むだけ）。--days=14 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
(async () => {
  const since = new Date(Date.now() - Number(arg("days", "14")) * 86400_000).toISOString();
  const rows: any[] = [];
  for (let from = 0; ; from += 100) {
    const { data, error } = await sb.from("search_audits").select("id, created_at, status, trigger, ext_version, cause_key, steps, result").eq("site", "realpro").gte("created_at", since).order("created_at", { ascending: true }).range(from, from + 99);
    if (error) { console.log(error.message); return; }
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 100) break;
  }
  const bulk = rows.filter((r) => r.trigger === "bulk_manual");
  console.log(`bulk_manual ${bulk.length} 件 / 全体 ${rows.length}`);
  const byVer = new Map<string, { n: number; fin: number; ab: number }>();
  bulk.forEach((r) => { const e = byVer.get(r.ext_version) || { n: 0, fin: 0, ab: 0 }; e.n++; if (r.status === "finished") e.fin++; if (r.status === "abandoned") e.ab++; byVer.set(r.ext_version, e); });
  console.log("版ごと(完了/放棄):", [...byVer.entries()].map(([v, e]) => `${v}:${e.fin}/${e.ab}`).join(" "));
  bulk.forEach((r) => {
    const st: any[] = r.steps || [];
    const pos = st.find((s) => s.k === "bulk_pos")?.d?.slice(0, 22) || "-";
    const last = st.length ? st[st.length - 1] : null;
    const ts = st.filter((s) => typeof s.at === "number");
    const dur = ts.length > 1 ? Math.round((ts[ts.length - 1].at - ts[0].at) / 1000) : 0;
    const res = r.result ? JSON.stringify(r.result).slice(0, 60) : "";
    console.log(`#${r.id} ${r.created_at.slice(5, 16)} ${r.ext_version} ${String(r.status).padEnd(9)} ${pos.padEnd(24)} ${String(dur).padStart(5)}s n=${String(st.length).padStart(3)} last=${last ? last.k : "-"} ${res}`);
  });
})();
