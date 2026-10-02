// scripts/build-property-search-knowledge.ts — 物件検索の整理済みの知識を作り直して整理する（決定論・LLM なし・既定は dry）
// 実行: npx tsx --env-file=.env.local scripts/build-property-search-knowledge.ts [--apply]
//   作り直し（希望→届けた先・言い直し）＋区のまとめ＋整理（統合・退役・食い違い・読まれない）。週1回は /api/cron/property-search-knowledge が同じ関数を回す
import { createClient } from "@supabase/supabase-js";
import { runKnowledgeCycle } from "../app/lib/property-search-knowledge-server";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const apply = process.argv.includes("--apply");

(async () => {
  const r = await runKnowledgeCycle(db, { dry: !apply });
  console.log(`■ 物件検索の知識の作り直し＋整理（${apply ? "書く" : "dry"}）`);
  console.log(JSON.stringify(r, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
