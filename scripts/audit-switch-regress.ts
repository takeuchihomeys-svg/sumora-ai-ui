// scripts/audit-switch-regress.ts — on にしたスイッチの悪化の見張り（#813）を本番の表に当てて朝の1行を出す（2026-11-27 作業員A）
//   読む物は小さい2つの表だけ（brain_switch_versions・quality_daily の物差し2つの70日）。書かない・LLM なし。
//   実行: npx tsx --env-file=.env.local scripts/audit-switch-regress.ts [--json]（brain_switch_versions は公開キーでは読めない＝本番の鍵 SUPABASE_SERVICE_ROLE_KEY のある所・cron で回す）
import { createClient } from "@supabase/supabase-js";
import { switchOnDays, switchesToWatch, groupByOnDay, decideSwitchRegress, regressMorningLine, WATCH_METRICS, type QualityRow, type SwitchVersion } from "../app/lib/switch-regress-watch";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase の環境変数が無い");
  const db = createClient(url, key);
  const today = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);
  const since = new Date(Date.now() - 70 * 864e5).toISOString().slice(0, 10);
  const { data: vers, error: e1 } = await db.from("brain_switch_versions").select("switches, first_seen_at").order("first_seen_at", { ascending: true }).limit(200);
  if (e1) throw e1;
  const { data: rows, error: e2 } = await db.from("quality_daily").select("day, metric, scope, value, n, source").in("metric", [...WATCH_METRICS]).gte("day", since).limit(2000);
  if (e2) throw e2;
  const onDays = switchOnDays((vers ?? []) as SwitchVersion[]);
  const watch = groupByOnDay(switchesToWatch(onDays, today)); // 同じ日に on の物は束で1つ
  const vs = watch.map((w) => decideSwitchRegress({ ...w, rows: (rows ?? []) as QualityRow[], todayYmd: today }));
  if (process.argv.includes("--json")) console.log(JSON.stringify(vs, null, 1));
  else for (const v of vs) console.log(`  ${v.verdict.padEnd(7)} ${v.name}（${v.onDay} on）: ${v.metrics.map((m) => `${m.metric}/${m.scope} ${m.verdict}`).join("・")}`);
  console.log(regressMorningLine(vs));
}
main().catch((e) => { console.error(e); process.exit(1); });
