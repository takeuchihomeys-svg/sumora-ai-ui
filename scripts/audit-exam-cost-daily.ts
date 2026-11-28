// scripts/audit-exam-cost-daily.ts — 晩ごとの試験の費用を llm_usage_logs の名札で数えて quality_daily に書く（統括役の決め 11/28・作業員L・LLM 0）
//   読みは DB の関数 exam_cost_by_night の集計1本だけ（全件を読まない）。前の N 晩を書き直す（遅れて入る行があるので既定 3晩）。
//   書く物: quality_daily exam_cost:main・own・other・total（day＝晩・scope all・own の detail に名札ごとの上位15）。朝の1枚が1行で出す（self-improve）
// 実行: npx tsx --env-file=.env.local scripts/audit-exam-cost-daily.ts [--nights=3] [--write]
import { createClient } from "@supabase/supabase-js";
import { nightCostsOf, qualityRowsOf, type CostRow } from "./lib/exam-cost-daily";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const nightKey = (ms: number) => new Date(ms + 9 * 3_600_000 - 12 * 3_600_000).toISOString().slice(0, 10);

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const nights = Math.max(1, Number(arg("nights", "3")) || 3);
  const to = nightKey(Date.now()), from = nightKey(Date.now() - (nights - 1) * 86_400_000);
  const { data, error } = await sb.rpc("exam_cost_by_night", { p_from: from, p_to: to });
  if (error) throw new Error(`exam_cost_by_night: ${error.message}`);
  const costs = nightCostsOf((data ?? []) as CostRow[]);
  for (const c of costs) console.log(`${c.night}: 係 $${c.main}・手元 $${c.own}・ほか $${c.other}・計 $${c.total}${c.own > 1 ? `｜手元の上位 ${c.ownRoutes.slice(0, 3).map((x) => `${x.route} $${x.usd}`).join("・")}` : ""}`);
  if (argv.includes("--write") && costs.length) {
    const rows = costs.flatMap((c) => qualityRowsOf(c, "scripts/audit-exam-cost-daily.ts（作業員L）"));
    const { error: we } = await sb.from("quality_daily").upsert(rows, { onConflict: "day,metric,scope" });
    if (we) throw new Error(`quality_daily: ${we.message}`);
    console.log(`quality_daily に ${rows.length}行（${from}〜${to}）`);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
