// scripts/reading-audit.ts — 読み取りの誤りの週の見張り（/api/cron/reading-audit-weekly と同じ中身）を手元で回す（読むだけ・LLM なし・$0）
// 実行: npx tsx --env-file=.env.local scripts/reading-audit.ts [--days=7]
export {};
async function main() {
  const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=7").split("=")[1]);
  const { weeklyReadingAudit } = await import("../app/lib/reading-audit-server");
  const r = await weeklyReadingAudit({ days });
  console.log(JSON.stringify(r, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
