// scripts/audit-brain-targets.ts — 読むだけ。ブレインのターゲット（今日のターゲット全リストの新しい中身）と、旧の is_flagged の一覧・hot の比較
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-targets.ts
// 2026-10-08 竹内さんの決定「ブレインの判断に寄せる」・ターゲットの正の基準（①内覧済み ②審査落ち ③新規 ④物件検索中）
import { supabase } from "@/app/lib/supabase";
import { loadBrainTargets } from "@/app/lib/brain-attention-server";
import { TARGET_TIER_LABEL, brainNeedsStaff, type AttentionMeta } from "@/app/lib/brain-attention";

async function main() {
  const targets = await loadBrainTargets(supabase);
  const byTier = new Map<string, typeof targets>();
  for (const t of targets) byTier.set(t.tier, [...(byTier.get(t.tier) ?? []), t]);
  console.log(`■ ブレインのターゲット ${targets.length}人`);
  for (const [tier, rows] of byTier) {
    console.log(`\n【${TARGET_TIER_LABEL[tier as keyof typeof TARGET_TIER_LABEL]}】${rows.length}人`);
    for (const r of rows.slice(0, 15)) console.log(`  ${r.customerName}（${r.summary}）  ${r.reason}  status=${r.status}`);
    if (rows.length > 15) console.log(`  …他 ${rows.length - 15}人`);
  }
  // 旧: is_flagged=true（申込以降を除く）
  const { data: flagged } = await supabase.from("conversations").select("id, customer_name, status, last_sender, suggested_aix_meta")
    .eq("is_flagged", true).not("status", "in", "(applying,screening,contract,closed_won,closed_lost)").limit(500);
  const { data: items } = await supabase.from("aix_action_items").select("conversation_id, action").eq("status", "pending");
  const itemBy = new Map(((items ?? []) as Array<{ conversation_id: string; action: string }>).map((r) => [r.conversation_id, r.action]));
  const f = (flagged ?? []) as Array<{ id: string; customer_name: string | null; status: string | null; last_sender: string | null; suggested_aix_meta: unknown }>;
  const needs = f.filter((c) => brainNeedsStaff({ meta: c.suggested_aix_meta as AttentionMeta, pendingAixAction: itemBy.get(c.id) ?? null, lastSender: c.last_sender, status: c.status }).needs);
  const tIds = new Set(targets.map((t) => t.conversationId));
  console.log(`\n■ 旧の is_flagged（申込以降を除く）${f.length}人 → うちブレインの要対応 ${needs.length}人・ブレインのターゲット ${f.filter((c) => tIds.has(c.id)).length}人`);
  // hot
  const { data: hot } = await supabase.from("property_customers").select("id").eq("status", "hot");
  const hotIds = new Set(((hot ?? []) as Array<{ id: string }>).map((r) => r.id));
  const targetPc = new Set(targets.map((t) => t.propertyCustomerId).filter(Boolean) as string[]);
  console.log(`■ 今の hot ${hotIds.size}人 → うちブレインのターゲット ${[...hotIds].filter((id) => targetPc.has(id)).length}人／ターゲットで hot でない ${[...targetPc].filter((id) => !hotIds.has(id)).length}人`);
}
main().catch((e) => { console.error(e); process.exit(1); });
