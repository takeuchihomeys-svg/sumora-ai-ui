// scripts/audit-apply-viewing-need.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-apply-viewing-need.ts
//
// 2026-09-20: 「申込が近いのに内覧が抜けている → 内覧を先に埋めるべき」は本当か。
//   前田さんの1件（内覧していなくて止まった）だけで規則にするのは設計知見に反する
//   （「実データで線を引く／外れた側の中身を必ず読む」）。対照群つきで測る。
//     群A: 申込に到達した会話 … 申込AIXの直前7日に内覧の合図があったか
//     群B: 申込が近い（hot）のに30日以上止まっている会話 … 同じ窓で同じものを数える
//   群Bだけ「内覧なし」が多ければ、内覧を先に埋める根拠になる。差が無ければ規則にしない。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
import { detectApplyReadiness, HOT_SCORE, type ApplyMsg } from "../app/lib/apply-readiness";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const APPLIED = ["applying", "application_push", "screening", "closed_won"];
const APPLY_AIX = ["application_push", "application_confirm"];
const STALE_D = 30;

async function msgsBefore(convId: string, beforeIso: string): Promise<ApplyMsg[]> {
  const { data } = await sb.from("messages").select("sender, text, created_at")
    .eq("conversation_id", convId).lt("created_at", beforeIso)
    .order("created_at", { ascending: false }).limit(200);
  return ((data ?? []) as Array<{ sender: string; text: string | null; created_at: string }>)
    .map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at }));
}
const hasViewing = (hits: Array<{ key: string }>) => hits.some((h) => h.key === "viewed" || h.key === "cust_viewing_req");

async function main() {
  const convs: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("conversations").select("id, customer_name, status, updated_at").range(from, from + 999);
    if (!data?.length) break;
    convs.push(...(data as Array<Record<string, unknown>>));
    if (data.length < 1000) break;
  }
  let aN = 0, aNoView = 0;
  const aNoViewNames: string[] = [];
  for (const c of convs.filter((x) => APPLIED.includes(String(x.status ?? "")))) {
    const { data: ap } = await sb.from("aix_usage_logs").select("created_at")
      .eq("conversation_id", c.id as string).in("aix_type", APPLY_AIX)
      .not("sent_at", "is", null).order("created_at", { ascending: true }).limit(1);
    if (!ap?.length) continue;
    const base = Date.parse(String(ap[0].created_at));
    const r = detectApplyReadiness(await msgsBefore(String(c.id), new Date(base).toISOString()), base);
    aN++; if (!hasViewing(r.hits)) { aNoView++; aNoViewNames.push(String(c.customer_name)); }
  }
  let bN = 0, bNoView = 0;
  const bNoViewNames: string[] = [];
  for (const c of convs.filter((x) => !APPLIED.includes(String(x.status ?? "")) && ["proposing", "viewing", "hearing", "property_recommendation", "condition_hearing", "availability_check", "estimate_request"].includes(String(x.status ?? "")))) {
    const base = Date.parse(String(c.updated_at ?? ""));
    if (!Number.isFinite(base) || Date.now() - base < STALE_D * 86400_000) continue;
    const r = detectApplyReadiness(await msgsBefore(String(c.id), new Date(base + 1000).toISOString()), base);
    if (r.score < HOT_SCORE || r.windowCount < 4) continue;   // 申込が近かったのに止まった会話だけ
    bN++; if (!hasViewing(r.hits)) { bNoView++; bNoViewNames.push(String(c.customer_name)); }
  }
  const pct = (a: number, b: number) => `${((100 * a) / Math.max(b, 1)).toFixed(0)}%`;
  console.log(`=== 申込の直前7日に「内覧の合図」があったか ===\n`);
  console.log(`  群A 申込に到達        ${aN}件 … 内覧の合図なし ${aNoView}件 (${pct(aNoView, aN)})`);
  console.log(`  群B 申込が近いのに停滞 ${bN}件 … 内覧の合図なし ${bNoView}件 (${pct(bNoView, bN)})`);
  console.log(`\n  差: ${(100 * bNoView) / Math.max(bN, 1) - (100 * aNoView) / Math.max(aN, 1) >= 0 ? "+" : ""}${((100 * bNoView) / Math.max(bN, 1) - (100 * aNoView) / Math.max(aN, 1)).toFixed(0)}pt`);
  console.log(`\n  群A で内覧なしのまま申込した人: ${aNoViewNames.join("・") || "なし"}`);
  console.log(`  群B で内覧なしのまま止まった人: ${bNoViewNames.join("・") || "なし"}`);
  console.log(`\n  ＝ 差が小さければ「内覧を先に埋める」は規則にしない（両方で同じくらい起きている）。`);
}
main().catch((e) => { console.error(e); process.exit(1); });
