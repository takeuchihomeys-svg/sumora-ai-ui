// scripts/preview-target-list.ts — 「🌟ターゲット🌟」の見本と hot から外す候補を本番のデータで出す（読むだけ・グループには流さない・DB に書かない・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/preview-target-list.ts
import { supabase } from "@/app/lib/supabase";
import { loadBrainTargets, loadScreeningList, syncBrainHotDrops } from "@/app/lib/brain-attention-server";
import { formatTargetList } from "@/app/lib/target-list-format";

async function main() {
  const [targets, screening, drops] = await Promise.all([
    loadBrainTargets(supabase), loadScreeningList(supabase), syncBrainHotDrops(supabase, { dryRun: true }),
  ]);
  const top = targets.filter((t) => t.tier === "viewed" || t.tier === "screening_failed").slice(0, 25);
  const rest = targets.filter((t) => t.tier === "new" || t.tier === "engaged").slice(0, 40);
  console.log(formatTargetList({
    targets: [...top, ...rest].map((t) => ({ mark: "", name: t.customerName, summary: t.summaryLine })),
    screening: screening.map((r) => ({ name: r.customerName, summary: r.summaryLine })),
  }));
  const byTier: Record<string, number> = {};
  for (const t of targets) byTier[t.tier] = (byTier[t.tier] ?? 0) + 1;
  console.log("\n--- 段ごとの人数:", JSON.stringify(byTier), "審査中:", screening.length);
  console.log(`--- hot から外す候補（dryRun）${drops.length}人`);
  for (const d of drops) console.log(`  ${d.customerName}: ${d.reason}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
