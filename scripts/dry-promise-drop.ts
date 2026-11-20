// scripts/dry-promise-drop.ts — 約束の取りこぼしの見張りを本番の記録で数えるだけ（書かない・LLM なし・費用0・営業時間の外に）
// 2026-11-21 作業員L。実行: npx tsx --env-file=.env.local scripts/dry-promise-drop.ts
import { createClient } from "@supabase/supabase-js";
import { loadPromiseDrops } from "../app/lib/promise-drop-watch-server";
import { buildPromiseDropPost } from "../app/lib/promise-drop-watch";
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const t0 = Date.now();
  const drops = await loadPromiseDrops(sb as never);
  console.log(`かかった ${((Date.now() - t0) / 1000).toFixed(1)}秒`);
  console.log(`件数 ${drops.length}・読んだ会話 ${drops.scanned}/${drops.total}・打ち切り ${!!drops.partial}`);
  for (const d of drops) console.log(`${d.conversationId.slice(0, 8)} ${d.kind} ${d.days}日 返事あり=${d.customerSpokeAfter} 取り下げ=${d.dismissedAfter} 候補=${d.readyPicksAfter}`);
  const t = buildPromiseDropPost(drops, Date.now());
  console.log("\n文の形（名前は伏せる）:\n" + (t ?? "(なし)").replace(/・[^\n]*さん →/g, "・〇〇さん →"));
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
