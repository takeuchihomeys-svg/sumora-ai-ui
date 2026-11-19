// scripts/prop-brain-daily.ts — 物件出しのブレインの毎日の物差しを手元で数える（読むだけ・LLM なし・費用 0）
// 本番の毎朝の数えは /api/cron/prop-brain-daily（prod-yardstick の cron-chain の子）。同じ関数（app/lib/prop-brain-daily-server.ts）を使う。
// 営業時間（JST 9〜22）は --days=1 程度の軽い読みだけにする。
// 実行: npx tsx --env-file=.env.local scripts/prop-brain-daily.ts [--days=7] [--json]
import { createClient } from "@supabase/supabase-js";
import { loadPropBrainDaily } from "../app/lib/prop-brain-daily-server";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
(async () => {
  const r = await loadPropBrainDaily(sb, { days: Number(args.days ?? 7) });
  console.log(r.summary);
  console.log(`  書き手ごとの🌟: ${(["takeuchi", "employee"] as const).map((w) => `${w} ${r.star[w].toolStarHit}/${r.star[w].toolStarN}（上位10 ${r.star[w].top10}/${r.star[w].poolN}）`).join("・")}`);
  console.log(`  条件の届き（種類ごと）: ${Object.entries(r.reach.byKind).map(([k, v]) => `${k} ${v.ok}/${v.n}`).join("・")}（履歴で届いた ${r.reach.reached}・作った時に入った ${r.reach.atCreate}・既に入っていた ${r.reach.already}）`);
  if (args.json) console.log(JSON.stringify(r));
})().catch((e) => { console.error(e); process.exit(1); });
