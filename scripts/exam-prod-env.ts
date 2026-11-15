// scripts/exam-prod-env.ts — 本番のスイッチの組（brain_switch_versions の最新の行）を試験の控え（exam-queue/prod-env.json）に読み、名前と既定との違いを出す（読むだけ・LLM なし）
//   2026-11-15 作業員I（統括役の見つけ）。試験の係が --prod-env の依頼・"prodEnv": "on" の時に3時間ごとに同じ控えを読み直す
// 実行: npx tsx --env-file=<鍵の .env> scripts/exam-prod-env.ts [--refresh]
import { createClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { readProdEnvCache, refreshProdEnv } from "./lib/exam-prod-env";

const FILE = join(examCacheRoot(), "exam-queue", "prod-env.json");
(async () => {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const c = process.argv.includes("--refresh") || !readProdEnvCache(FILE) ? await refreshProdEnv(db as never, FILE) : readProdEnvCache(FILE);
  if (!c) { console.error("読めない（brain_switch_versions・サービスの鍵が要る）"); process.exit(1); }
  const keys = Object.keys(c.env).sort();
  const off = keys.filter((k) => /^(off|false|0)$/i.test(c.env[k])), on = keys.filter((k) => !off.includes(k));
  console.log(`hash ${c.hash}・${keys.length}個（表の行は ${c.n}個・commit ${String(c.commit ?? "?").slice(0, 7)}・最後に見た ${c.lastSeenAt}）→ ${FILE}`);
  console.log(`off の上書き ${off.length}: ${off.join(" ")}`);
  console.log(`on・値の上書き ${on.length}: ${on.map((k) => (/^on$/i.test(c.env[k]) ? k : `${k}=${c.env[k]}`)).join(" ")}`);
})();
