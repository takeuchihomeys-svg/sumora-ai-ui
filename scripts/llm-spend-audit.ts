// scripts/llm-spend-audit.ts — LLM の使った額の見張り（/api/cron/reading-audit-weekly の llmSpend と同じ中身）を手元で回す（読むだけ・LLM なし・$0）
// 実行: npx tsx --env-file=.env.local scripts/llm-spend-audit.ts [--days=7] [--json]
export {};
async function main() {
  const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=7").split("=")[1]) || 7;
  const { fetchLlmSpend } = await import("../app/lib/llm-spend-audit");
  const r = await fetchLlmSpend({ days });
  if (process.argv.includes("--json")) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`直近${days}日 $${r.week.usd}（${r.week.calls}回・本番 $${r.week.byEnv.production}／手元 $${r.week.byEnv.local}）  前の${days}日 $${r.prevWeek.usd}（${r.prevWeek.calls}回・本番 $${r.prevWeek.byEnv.production}／手元 $${r.prevWeek.byEnv.local}）  差 ${r.diff.usd >= 0 ? "+" : ""}$${r.diff.usd}（${r.diff.ratio ?? "-"}倍）`);
  for (const k of ["claude", "deepseek", "jev"] as const) console.log(`  ${k.padEnd(8)} $${String(r.week.byFamily[k]).padStart(7)} ← $${r.prevWeek.byFamily[k]}`);
  console.log("日（JST）      回数     合計    Claude  DeepSeek");
  for (const d of r.daily) console.log(`${d.day} ${String(d.calls).padStart(6)} ${("$" + d.usd).padStart(8)} ${("$" + d.claude).padStart(8)} ${("$" + d.deepseek).padStart(8)}`);
  if (Object.keys(r.unpriced).length) console.log("単価なし（0 で数えた）:", r.unpriced);
  console.log(r.alerts.length ? `⚠ ${r.alerts.join(" / ")}` : "印なし");
}
main().catch((e) => { console.error(e); process.exit(1); });
