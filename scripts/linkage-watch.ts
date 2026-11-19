// scripts/linkage-watch.ts — 連携の地図の見張りを手元で（読むだけ・LLM なし・費用0）。作業員H の朝の1本の cron から呼ぶ runLinkageWatchAndLog と同じ関数
//
// 2026-11-15 作業員L。人が読む md（切れている行を一番上に・段ごと）と1行の要約を出す。
// 実行: npx tsx --env-file=.env.local scripts/linkage-watch.ts [--md=<出力の md>] [--write]（--write で cron_run_logs に1行）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { runLinkageWatch, compactResult, LINKAGE_CRON_NAME } from "../app/lib/linkage-watch-server";
import { formatLinkageMd } from "../app/lib/linkage-map";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const started = new Date().toISOString();
  const rep = await runLinkageWatch(sb);
  console.log(rep.summary);
  for (const n of rep.notes) console.log(`  メモ: ${n}`);
  const md = formatLinkageMd(rep);
  if (arg("md")) { writeFileSync(arg("md")!, md); console.log(`md: ${arg("md")}`); } else console.log(md);
  if (process.argv.includes("--write")) {
    const { error } = await sb.from("cron_run_logs").insert({ cron_name: LINKAGE_CRON_NAME, started_at: started, finished_at: new Date().toISOString(), ok: true, result_json: compactResult(rep) });
    console.log(error ? `書けなかった: ${error.message}` : "cron_run_logs に1行");
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
