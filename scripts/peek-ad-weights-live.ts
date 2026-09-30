// 本番の重みの版（scoring_weights）とお客様ごとの倍率に AD の札が入っていないか・保存の行の AD の札と点の分布（読み取りのみ）
//   npx tsx --env-file=.env.local scripts/peek-ad-weights-live.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const { data: ws, error } = await sb.from("scoring_weights").select("*").order("version", { ascending: false }).limit(10);
  if (error) console.log("scoring_weights:", error.message);
  for (const w of ws ?? []) {
    const ad = Object.entries((w.weights ?? {}) as Record<string, number>).filter(([k]) => /^AD_|PROFIT/.test(k));
    console.log(`版 ${w.version} ${w.status} ${String(w.created_at).slice(0, 10)} 札数 ${Object.keys(w.weights ?? {}).length} AD の札: ${JSON.stringify(ad)}`);
  }
  // 9/27 以降の行: AD の札ごとの件数
  const { data: rows } = await sb.from("property_pickups").select("id, created_at, reason_codes, verdict, summary_text, pdf_text").gte("created_at", "2026-09-27T00:00:00Z").limit(5000);
  const cnt: Record<string, number> = {};
  let assumed = 0, under = 0, unk = 0;
  for (const r of rows ?? []) {
    for (const c of (r.reason_codes ?? []) as string[]) if (/^AD_/.test(c)) cnt[c] = (cnt[c] ?? 0) + 1;
    const cs = (r.reason_codes ?? []) as string[];
    if (cs.includes("AD_ASSUMED_AGENT")) assumed++;
    if (cs.includes("AD_UNDER_1M")) under++;
    if (cs.includes("AD_UNKNOWN")) unk++;
  }
  console.log(`9/27〜 ${rows?.length} 行`, cnt, { assumed, under, unk });
  const { count: wc } = await sb.from("scoring_weights").select("version", { count: "exact", head: true });
  console.log("scoring_weights の行数:", wc);
  const { data: pw, error: e2 } = await sb.from("scoring_pref_weights").select("*").order("created_at", { ascending: false }).limit(3);
  if (e2) console.log("customer_pref_weight_versions:", e2.message);
  else for (const v of pw ?? []) console.log("pref:", JSON.stringify(v).slice(0, 400));
}
main().catch((e) => { console.error(e); process.exit(1); });
