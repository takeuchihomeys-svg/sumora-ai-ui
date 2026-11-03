// scripts/ops-anomaly-dry.ts — 本番の異常の知らせを手元で数えるだけ（書かない・件数の集計だけ・LLM なし）
//   実行: npx tsx --env-file=.env.local scripts/ops-anomaly-dry.ts
import { opsAdminClient, runOpsAnomalyWatch } from "../app/lib/ops-anomaly-server";
(async () => {
  const db = opsAdminClient();
  if (!db) { console.log("SUPABASE_SERVICE_ROLE_KEY が無い"); return; }
  const t0 = Date.now();
  const r = await runOpsAnomalyWatch(db, { dry: true });
  console.log(JSON.stringify({ ms: Date.now() - t0, stats: r.stats, anomalies: r.anomalies }, null, 1));
})();
