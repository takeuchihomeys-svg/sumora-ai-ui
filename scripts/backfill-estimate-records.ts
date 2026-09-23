// 過去の AIX【見積書送る】（aix_usage_logs estimate_sheet）から estimate_records を埋め戻し、AD と結び付いた率を出す。
// 2026-09-24 竹内「AD − 見積書の割引金額が利益。物件オススメ・ピックアップで送った物件なら AD も理解しているはず。連動する」
// 実行: npx tsx --env-file=.env.local scripts/backfill-estimate-records.ts [--days=365] [--dry-run] [--limit=1000]
import { createClient } from "@supabase/supabase-js";
import { recordEstimateFromAix } from "../app/lib/estimate-profit-server";
import { summarizeEstimateProfit, formatProfitNote } from "../app/lib/estimate-profit";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "365"));
const LIMIT = Number(arg("limit", "1000"));
const DRY = process.argv.includes("--dry-run");

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const { data, error } = await sb.from("aix_usage_logs").select("id, conversation_id, generated_text, created_at, estimate_sent, aix_type")
    .or("aix_type.eq.estimate_sheet,estimate_sent.eq.true").gte("created_at", since).order("created_at", { ascending: false }).limit(LIMIT);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; conversation_id: string; generated_text: string | null; created_at: string }>;
  console.log(`=== 見積書の AIX ${rows.length}通（${DAYS}日）${DRY ? "・下見だけ（書かない）" : ""} ===`);
  let items = 0, recorded = 0, linked = 0, noItems = 0, failed = 0;
  for (const r of rows) {
    const res = await recordEstimateFromAix({ aixUsageLogId: r.id, conversationId: r.conversation_id, generatedText: r.generated_text, createdAt: r.created_at, dryRun: DRY });
    items += res.items; recorded += res.recorded; linked += res.linked;
    if (res.skipped === "no_items") noItems++; else if (res.skipped) failed++;
  }
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
  console.log(`物件の行 ${items}（本文から読めなかった通 ${noItems}・失敗 ${failed}）`);
  console.log(`記録 ${recorded}／AD と結び付いた ${linked}（${pct(linked, items)}）`);
  if (!DRY) {
    const { data: all } = await sb.from("estimate_records").select("discount_yen, ad_yen, profit_yen, ad_source").gte("estimated_at", since).limit(5000);
    const recs = (all ?? []) as Array<{ discount_yen: number | null; ad_yen: number | null; profit_yen: number | null; ad_source: string | null }>;
    console.log(`\n全体: ${formatProfitNote(summarizeEstimateProfit(recs))}`);
    const bySrc: Record<string, number> = {};
    for (const r of recs) bySrc[r.ad_source ?? "(なし)"] = (bySrc[r.ad_source ?? "(なし)"] ?? 0) + 1;
    console.log(`AD の出所: ${JSON.stringify(bySrc)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
