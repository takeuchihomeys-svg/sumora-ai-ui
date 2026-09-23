// YUMA で「会話全体の戦略」の普段の整理（consolidate）を1回走らせ、押した AIX・流れ・行動台帳が戦略に効いているかを目で読む
//
// 2026-09-23 竹内「フル分析はどのAIXをつかったのか、どのような流れなのかも分析して…方向性を考えるようになっているのか」→「３はおこなう」
//
// ⚠ 書き込みあり（conversations.brain_strategy と property_customers.ai_summary）。YUMA だけ。
//   走らせる前に scripts/yuma-snapshot.ts save、終わったら restore（brain_strategy も控える対象に入れた）。
// 実行: npx tsx --env-file=.env.local scripts/yuma-snapshot.ts save
//       npx tsx --env-file=.env.local scripts/yuma-strategy-refresh.ts
//       npx tsx --env-file=.env.local scripts/yuma-snapshot.ts restore
import { createClient } from "@supabase/supabase-js";

const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const { runStrategyRefresh } = await import("../app/lib/brain-core");
  const { data: before } = await sb.from("conversations").select("brain_strategy").eq("id", YUMA).maybeSingle();
  const prev = (before?.brain_strategy ?? null) as Record<string, unknown> | null;
  console.log(`=== 前の戦略（count=${prev?.strategy_count ?? "-"}・source=${prev?.source ?? "-"}）===`);
  console.log(`closing: ${String(prev?.closing_strategy ?? "").slice(0, 200)}`);
  console.log(`steps  : ${JSON.stringify(prev?.next_steps ?? [])}`);

  const { data: aix } = await sb.from("aix_usage_logs").select("aix_type, created_at").eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(5);
  console.log(`\n=== 押した AIX（新→旧・5件）===\n${((aix ?? []) as Array<{ aix_type: string; created_at: string }>).map((a) => `${a.created_at.slice(5, 16)} ${a.aix_type}`).join(" / ")}`);

  const t0 = Date.now();
  const next = await runStrategyRefresh(YUMA, "consolidate", "test:aix-flow");
  console.log(`\n=== 整理した戦略（${Date.now() - t0}ms）===`);
  if (!next) { console.log("（保存されなかった: 新しい戦略が既にある・整理に失敗・同時実行）"); return; }
  console.log(`count=${next.strategy_count} source=${next.source} stage=${next.checkpoint_stage} signal=${next.purchase_signal_level}`);
  console.log(`closing: ${next.closing_strategy}`);
  console.log(`winning: ${next.winning_pattern}`);
  console.log(`steps  :`); for (const s of next.next_steps ?? []) console.log(`  - ${s}`);
  console.log(`\n→ 目で読む: Step に「既に押した AIX（上の一覧）」をもう一度書いていないか／次の段階になっているか`);
}
main().catch((e) => { console.error(e); process.exit(1); });
