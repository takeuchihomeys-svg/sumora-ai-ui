// scripts/audit-link-brain.ts — つなぎのブレイン 段1の見張りを直近 N日に流し、つなぎごとの切れの数と伏せた例3つずつを出す（読むだけ・LLM なし・書かない）
//   この数が「線を太くする」前の基準（baseline）。判定は app/lib/link-brain-watch.ts（毎晩の cron と同じ関数）
// 実行: npx tsx --env-file=.env.local scripts/audit-link-brain.ts [--days=14] [--json]
import { createClient } from "@supabase/supabase-js";
import { runLinkWatch } from "../app/lib/link-brain-watch-server";
import { renderLinkSummary, compactLinkSummary } from "../app/lib/link-brain-watch";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=14").slice(7));
(async () => {
  const nowMs = Date.now();
  const s = await runLinkWatch(sb, { fromMs: nowMs - DAYS * 86_400_000, toMs: nowMs, nowMs }, { examplesPerType: 3 });
  console.log(renderLinkSummary(s, { examples: true }));
  console.log(`\nやることリストに足す候補（LINK_BRAIN_TODO=on の時）: ${s.todo.length}`);
  if (process.argv.includes("--json")) console.log(JSON.stringify(compactLinkSummary(s), null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
