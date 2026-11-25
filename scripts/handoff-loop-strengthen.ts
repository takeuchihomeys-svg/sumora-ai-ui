/**
 * 連続客ループ細分化の強化計画（無料・DB読むだけ）
 *
 *   npx tsx --env-file=.env.local scripts/handoff-loop-strengthen.ts
 *   → 直近自動監査から細原子を数え、弱い所を無料優先で出す。
 *   推測で課題を増やさない。印の有無だけ。
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  countFineAtomsAcrossAudits,
  planHandoffStrengthen,
  HANDOFF_FINE_ORDER,
} from "../app/lib/handoff-loop-ledger";

const STAMP = "memory/handoff_loop_strengthen_last.json";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  if (!url || !key) {
    console.error("Supabase 環境変数が無い");
    process.exit(1);
  }
  const sb = createClient(url, key);
  const { data, error } = await sb
    .from("search_audits")
    .select("id,steps,ext_version,mode,created_at,status")
    .eq("site", "realpro")
    .in("mode", ["brain_aix", "aix", "auto"])
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) {
    console.error("監査取得失敗:", error.message);
    process.exit(1);
  }
  const rows = data || [];
  const tallied = countFineAtomsAcrossAudits(rows);
  const latest = rows[0];
  const plan = planHandoffStrengthen(
    Array.isArray(latest?.steps) ? (latest!.steps as Array<{ k?: string; d?: string }>) : [],
  );
  const stamp = {
    at: new Date().toISOString(),
    runs: tallied.runs,
    counts: tallied.counts,
    weak: tallied.weak,
    line: tallied.line,
    latest_plan: plan,
    fine_n: HANDOFF_FINE_ORDER.length,
    next: plan.next,
  };
  writeFileSync(join(process.cwd(), STAMP), JSON.stringify(stamp, null, 2), "utf8");
  console.log("■ 連続客ループ細分化強化");
  console.log("  " + tallied.line);
  console.log("  最新1本: " + plan.line);
  console.log("  次手: " + plan.next);
  if (plan.items.length) {
    console.log("  弱い細原子（無料優先）:");
    for (const it of plan.items.slice(0, 8)) {
      console.log(`    [${it.foundation}/${it.layer}] ${it.id}: ${it.next}`);
    }
  }
  console.log("  スタンプ: " + STAMP);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
