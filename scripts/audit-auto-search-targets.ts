// scripts/audit-auto-search-targets.ts
// 2026-09-19 竹内「毎日11:00になったら3日以内物件確認している人や新規のお客さんの物件検索自動で」
// 本番の物件顧客に selectAutoSearchTargets を当てて、**実際に何人が対象になるか**を数える。
// 判定は app/lib/auto-search-schedule.ts をそのまま呼ぶ（SQL に条件を書き写さない）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-auto-search-targets.ts
import { createClient } from "@supabase/supabase-js";
import { selectAutoSearchTargets, rpUpdateDaysFor, lastPropertyTouchAt, MAX_TARGETS_PER_RUN } from "../app/lib/auto-search-schedule";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

async function main() {
  const { data, error } = await sb
    .from("property_customers")
    .select("id, customer_name, status, last_property_sent_at, property_viewed_at, created_at, desired_area, area")
    .limit(1000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string; customer_name: string | null; status: string | null;
    last_property_sent_at: string | null; property_viewed_at: string | null; created_at: string | null;
    desired_area: string | null; area: string | null;
  }>;
  console.log(`物件顧客 ${rows.length} 人\n`);

  // 上限なしで見る（本来何人か）
  const all = selectAutoSearchTargets(rows, { limit: 10_000 });
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const recent = all.filter((t) => t.reason === "recent_sent");
  const fresh = all.filter((t) => t.reason === "new_customer");
  const bySent = recent.filter((t) => { const c = byId.get(t.id); return !!c?.last_property_sent_at && lastPropertyTouchAt(c) === c.last_property_sent_at; });
  const byViewed = recent.filter((t) => { const c = byId.get(t.id); return !!c?.property_viewed_at && lastPropertyTouchAt(c) === c.property_viewed_at; });
  console.log(`対象（上限なし）: ${all.length} 人`);
  console.log(`  ・直近3日に物件出しした人 : ${recent.length} 人（送信が最後 ${bySent.length} ／ 確認が最後 ${byViewed.length}）`);
  console.log(`  ・まだ一度も出していない人（登録3日以内）: ${fresh.length} 人`);

  // 条件が無い人は検索できない（拡張が空振りする）
  const noCond = all.filter((t) => { const c = byId.get(t.id); return !c?.desired_area && !c?.area; });
  console.log(`  ※ うち検索条件（エリア）が無い人: ${noCond.length} 人（拡張が空振りするので積まない方がよい）`);

  const capped = selectAutoSearchTargets(rows, { limit: MAX_TARGETS_PER_RUN });
  console.log(`\n1回に積む上限 ${MAX_TARGETS_PER_RUN} 件で切ると: ${capped.length} 人`);

  // 更新日の分布（11時の便で実際に入る値）
  const dist: Record<string, number> = {};
  for (const t of all) {
    const k = t.rpUpdateDays === null ? "絞らない（初回）" : `${t.rpUpdateDays}日以内`;
    dist[k] = (dist[k] ?? 0) + 1;
  }
  console.log("\n11時の便で入る「更新日」の内訳:");
  for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v} 人`);

  console.log("\n先頭10人（優先順位順・hot → 直近送付 → 新規）:");
  for (const t of capped.slice(0, 10)) {
    const c = byId.get(t.id);
    // 表示も本番と同じ値（送信と確認の新しい方から計算した t.rpUpdateDays）を出す
    const touched = c ? lastPropertyTouchAt(c) : null;
    const which = !touched ? "—" : touched === c?.property_viewed_at ? "確認" : "送信";
    console.log(`  ${(c?.customer_name ?? "?").padEnd(12)} status=${String(c?.status).padEnd(16)} 理由=${t.reason.padEnd(12)} 最後=${which} 更新日=${t.rpUpdateDays ?? "なし"}`);
  }
  void rpUpdateDaysFor;
}

main().catch((e) => { console.error(e); process.exit(1); });
