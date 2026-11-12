// scripts/audit-unknowns-post-apply-gate.ts — 自己申告の分からない事に申込以降の門（BRAIN_UNKNOWNS_POST_APPLY_GATE）を当てた前後（読むだけ・LLM なし・営業時間外に）
//   実行: npx tsx --env-file=<鍵のある .env.local> scripts/audit-unknowns-post-apply-gate.ts
import { createClient } from "@supabase/supabase-js";
import { loadSelfReportHits } from "../app/lib/unknowns-intake-server";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
(async () => {
  const to = new Date().toISOString(), from = new Date(Date.now() - 86400e3).toISOString();
  process.env.BRAIN_UNKNOWNS_POST_APPLY_GATE = "off"; const a = await loadSelfReportHits(sb, from, to);
  process.env.BRAIN_UNKNOWNS_POST_APPLY_GATE = "on"; const b = await loadSelfReportHits(sb, from, to);
  const keys = (h: typeof a) => new Set(h.map((x) => `${x.kind}:${x.key}`));
  const ka = keys(a), kb = keys(b);
  console.log(`off: hits ${a.length} keys ${ka.size} / on: hits ${b.length} keys ${kb.size}`);
  const post = /審査|契約|書類|保証会社|印鑑|支払|口座|申込/;
  console.log("on に残った申込の語の鍵:", [...kb].filter((k) => post.test(k)).slice(0, 12).join(" | "));
  console.log("on に残った鍵:", [...kb].filter((k) => !post.test(k)).join(" | "));
})();
