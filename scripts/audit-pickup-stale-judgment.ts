// scripts/audit-pickup-stale-judgment.ts — 条件の更新より古い判定の、送る前の候補（pending）の数（読むだけ・LLM なし・費用0）
//
// 2026-11-21 作業員K2（台帳 #476）: PICKUP_REJUDGE_ON_COND の確かめ（試験ではなく本番の数）。
//   古い判定＝保存した設備の照合の希望の組（key・mode・strong）が、今のお客様の条件から読んだ希望の組と違う（pickup-rejudge-equipment.needsEquipRejudge と同じ線）。
//   付け直した行（equipment.rejudgedAt）の数も出す。名前・文は出さない。
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-stale-judgment.ts [--days=14]
import { createClient } from "@supabase/supabase-js";
import { parseEquipmentWants, type CustomerConditionsLike } from "../app/lib/listing-equipment";
import { needsEquipRejudge } from "../app/lib/pickup-rejudge-equipment";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "14")) || 14;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data, error } = await sb.from("property_pickups").select("id, property_customer_id, conversation_id, equipment, status, sent_at").eq("status", "pending").is("sent_at", null).gte("created_at", since).limit(3000);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Array<{ id: number; property_customer_id: string | null; conversation_id: string | null; equipment: unknown }>)
    .filter((r) => r.property_customer_id && !isTestConversation(r.conversation_id) && !isNoLineTestConversation(r.conversation_id));
  const ids = [...new Set(rows.map((r) => r.property_customer_id as string))];
  const pcs = new Map<string, CustomerConditionsLike>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data: p } = await sb.from("property_customers").select("id, preferences, ng_points, other_requests, additional_conditions, structure_types").in("id", ids.slice(i, i + 100));
    for (const x of (p ?? []) as Array<CustomerConditionsLike & { id: string }>) pcs.set(x.id, x);
  }
  let stale = 0, rejudged = 0; const staleCustomers = new Set<string>();
  for (const r of rows) {
    const pc = pcs.get(r.property_customer_id as string);
    if (!pc) continue;
    if ((r.equipment as { rejudgedAt?: string } | null)?.rejudgedAt) rejudged++;
    if (needsEquipRejudge(r.equipment, parseEquipmentWants(pc).wants)) { stale++; staleCustomers.add(r.property_customer_id as string); }
  }
  console.log(`送る前の候補 ${rows.length}行（${days}日・${ids.length}人）: 条件の更新より古い判定 ${stale}行（${staleCustomers.size}人）・付け直した行 ${rejudged}`);
})().catch((e) => { console.error(e); process.exit(1); });
