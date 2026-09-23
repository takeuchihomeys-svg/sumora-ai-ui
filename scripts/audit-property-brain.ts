// scripts/audit-property-brain.ts
// 物件検索ブレインの判定を「実際に送った物件」（property_candidate_pools＝送信時の候補・紐付き95%）に当てて、
// 「実送信を drop にした率」（＝誤削除の上限）と hold の分布を出す。DB は読むだけ。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-property-brain.ts [--days=30] [--show=20]
//
// ⚠ 今の pools には rent（2件）・敷礼（0件）・徒歩（0件）が無く、判定できるのは 間取り・AD・送付済み だけ。
//   家賃・敷礼・徒歩・利益の線は、影の運用で property_brain_judgments に facts と説明文が溜まってから引く。
import { createClient } from "@supabase/supabase-js";
import { buildCustomerProfile, judgeProperty, parsePropertyFacts, type CustomerLike, type Judgment } from "../app/lib/property-brain";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a, "1"]; }));
const DAYS = parseInt(String(args.days ?? "30"), 10);
const SHOW = parseInt(String(args.show ?? "20"), 10);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
if (!url || !key) { console.error("Supabase の環境変数が無い（--env-file=.env.local）"); process.exit(1); }
const sb = createClient(url, key);

type Cand = { rank?: number; name?: string; rent?: number | null; floor_plan?: string | null; walk_minutes?: number | null; ad_months?: number | null };

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const { data: pools, error } = await sb.from("property_candidate_pools")
    .select("id, property_customer_id, site, candidates, sent_at")
    .gte("sent_at", since).not("property_customer_id", "is", null).order("sent_at", { ascending: false }).limit(3000);
  if (error) throw error;
  const rows = (pools ?? []) as Array<{ id: string; property_customer_id: string; site: string | null; candidates: Cand[]; sent_at: string }>;
  const custIds = [...new Set(rows.map((r) => r.property_customer_id))];
  console.log(`プール ${rows.length}件・お客様 ${custIds.length}人（${DAYS}日）`);

  const { data: custs } = await sb.from("property_customers")
    .select("id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet")
    .in("id", custIds);
  const custMap = new Map<string, CustomerLike>();
  for (const c of (custs ?? []) as Array<CustomerLike & { id: string }>) custMap.set(c.id, c);

  // 同じ日に別のお客様へ同じ物件が入っている検索は除く（別人の検索が混ざった疑い・設計の反証②）
  const dayNameCust = new Map<string, Set<string>>();
  for (const r of rows) for (const c of r.candidates ?? []) {
    const k = `${r.sent_at.slice(0, 10)}|${c.name ?? ""}`;
    if (!dayNameCust.has(k)) dayNameCust.set(k, new Set());
    dayNameCust.get(k)!.add(r.property_customer_id);
  }

  const counts = { pass: 0, hold: 0, drop: 0 };
  const codeCounts: Record<string, number> = {};
  const drops: Array<{ j: Judgment; cust: string; site: string | null }> = [];
  let judged = 0, skippedMixed = 0, noCustomer = 0;
  const profileCache = new Map<string, ReturnType<typeof buildCustomerProfile>>();

  for (const r of rows) {
    const cust = custMap.get(r.property_customer_id);
    if (!cust) { noCustomer++; continue; }
    // 送付済みは「このプールより前」の分だけにしたいが、簡便に history は空で当てる（ALREADY_SENT は skip-sent が別に持つ）
    let profile = profileCache.get(r.property_customer_id);
    if (!profile) { profile = buildCustomerProfile(cust, [], []); profileCache.set(r.property_customer_id, profile); }
    for (const c of r.candidates ?? []) {
      const k = `${r.sent_at.slice(0, 10)}|${c.name ?? ""}`;
      if ((dayNameCust.get(k)?.size ?? 0) > 1) { skippedMixed++; continue; }
      const summary = `【${c.rank ?? 0}】${c.name ?? "物件"}\n${c.floor_plan ?? ""}`;
      const j = judgeProperty(parsePropertyFacts(summary, c), profile);
      judged++;
      counts[j.verdict]++;
      for (const code of j.flagCodes) codeCounts[code] = (codeCounts[code] ?? 0) + 1;
      if (j.verdict === "drop") drops.push({ j, cust: r.property_customer_id.slice(0, 8), site: r.site });
    }
  }

  console.log(`\n判定 ${judged}件（別人混入の疑いで除外 ${skippedMixed}・お客様不明 ${noCustomer}）`);
  console.log(`  pass ${counts.pass}（${(100 * counts.pass / judged).toFixed(1)}%）／hold ${counts.hold}（${(100 * counts.hold / judged).toFixed(1)}%）／drop ${counts.drop}（${(100 * counts.drop / judged).toFixed(1)}%）`);
  console.log(`  ⚠ 実送信の drop 率 = 誤削除の上限。0 でなければ PROPERTY_BRAIN_DROP=on にしない`);
  console.log("\nhold / drop の理由コード:");
  for (const [code, n] of Object.entries(codeCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${code.padEnd(28)} ${n}`);
  if (drops.length) {
    console.log(`\ndrop の実物（先頭 ${SHOW}件・目で読む）:`);
    for (const d of drops.slice(0, SHOW)) console.log(`  [${d.cust}] ${d.j.name} ${d.j.facts.floorPlan ?? "-"} AD${d.j.facts.adMonths ?? "?"} → ${d.j.flagCodes.join(",")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
