// scripts/audit-floor-plan-too-small.ts — 「間取りが希望より小さい＝外す」の線を実際に送った物件に当てる（読むだけ）
// 2026-09-30 c さん（2LDK 希望に 1K を50件）。isTooSmallPlan が、スタッフが実際にお客様へ送った物件（status=sent）を外さないか・
//   未送信の候補でどれだけ外れるかを数える。
// 実行: npx tsx --env-file=.env.local scripts/audit-floor-plan-too-small.ts [--days=30]
import { createClient } from "@supabase/supabase-js";
import { normalizeFloorPlanWant, isTooSmallPlan, normalizeFloorPlanToken } from "../app/lib/property-brain";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.argv.slice(2).find((a) => a.startsWith("--days="))?.slice(7) ?? "30") || 30;
type P = { id: number; property_customer_id: string | null; status: string | null; summary_text: string | null; property_name: string | null; created_at: string };

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rows: P[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("property_pickups").select("id, property_customer_id, status, summary_text, property_name, created_at").gte("created_at", since).order("id").range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as P[]));
    if (!data || data.length < 1000) break;
  }
  const { data: pcs } = await sb.from("property_customers").select("id, customer_name, floor_plan").limit(5000);
  const fp = new Map(((pcs ?? []) as Array<{ id: string; floor_plan: string | null }>).map((c) => [c.id, c.floor_plan]));
  let sent = 0, sentSmall = 0, pend = 0, pendSmall = 0, noPlan = 0;
  const show: string[] = [];
  for (const r of rows) {
    const want = normalizeFloorPlanWant(r.property_customer_id ? fp.get(r.property_customer_id) ?? null : null);
    const plan = normalizeFloorPlanToken(r.summary_text ?? "");
    if (!plan) { noPlan++; continue; }
    const small = isTooSmallPlan(want, plan);
    if (r.status === "sent") { sent++; if (small) { sentSmall++; show.push(`[送った] #${r.id} 希望=${want.raw ?? ""} 物件=${plan} ${r.property_name ?? ""}`); } }
    else { pend++; if (small) { pendSmall++; if (show.length < 25) show.push(`[未送信] #${r.id} ${r.created_at.slice(5, 16)} 希望=${want.raw ?? ""} 物件=${plan} ${r.property_name ?? ""}`); } }
  }
  console.log(`直近${DAYS}日: 送った ${sent}件のうち小さい ${sentSmall}件 ／ 未送信 ${pend}件のうち小さい ${pendSmall}件 ／ 間取りが読めない ${noPlan}件`);
  for (const s of show) console.log("  " + s);
}
main().catch((e) => { console.error(e); process.exit(1); });
