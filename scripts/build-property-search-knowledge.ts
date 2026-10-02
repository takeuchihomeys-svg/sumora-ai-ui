// scripts/build-property-search-knowledge.ts — 物件検索の整理済みの知識を作り直す（決定論・LLM なし・既定は dry）
// 実行: npx tsx --env-file=.env.local scripts/build-property-search-knowledge.ts [--apply]
//   ・希望の駅・区 → スタッフが実際にお客様へ届けた部屋の駅・区（人数・申込に進んだ人の分）
//   ・エリアの言い直し（前 → 後）
//   書くのは --apply の時だけ（既にある鍵は差し替え・消さない）。週1回の作り直しの口（cron）は vercel.json（親の担当）
import { createClient } from "@supabase/supabase-js";
import { rebuildSearchKnowledge } from "../app/lib/property-search-knowledge-server";
import { readable } from "../app/lib/property-search-knowledge";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const apply = process.argv.includes("--apply");

(async () => {
  const r = await rebuildSearchKnowledge(db, { dry: !apply });
  console.log(`■ 物件検索の知識（${apply ? "書く" : "dry"}）: ${JSON.stringify(r.counts)}・書いた ${r.written}`);
  console.log("■ 希望 → 届けた（人数の多い順・読める物）");
  for (const k of readable(r.delivered).slice(0, 15)) console.log(`  ${k.content}`);
  console.log("■ エリアの言い直し（読める物）");
  for (const k of readable(r.restatement).slice(0, 10)) console.log(`  ${k.content}`);
})().catch((e) => { console.error(e); process.exit(1); });
