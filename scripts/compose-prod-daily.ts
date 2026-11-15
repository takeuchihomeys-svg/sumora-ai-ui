// scripts/compose-prod-daily.ts — 文の当たりを本番で毎日数える（読むだけ・LLM なし・費用0・2026-11-15 作業員H・統括役の頼み②）
//   竹内さん本人の実送信（line_watch_turns.staff_texts・書き手は messages.staff_writer＝takeuchi・AIX でない返信）と、その番の下書き（draft_last）を、
//   文の要素ごと（頭・押さえ・信頼・潜在・つなぎ・締め・事実・2通目）に比べる（scripts/lib/compose-prod-elements.ts・読みは scripts/lib/compose-prod-daily-db.ts）。
//   毎朝の cron は app/api/cron/compose-prod-daily（同じ読み・cron_run_logs に残す）。ここは手元の確かめ（--show で番ごと・--before で前の窓も）
//   --write で cron_run_logs に1行（cron_name=compose-prod-daily）。営業時間（JST 9〜22時）は回さない（--force で手元の確かめだけ）
//   使い方: npx tsx --env-file=<.env.local> scripts/compose-prod-daily.ts [--days=7] [--write] [--force] [--show=10] [--before]
import { createClient } from "@supabase/supabase-js";
import { PROD_ELEMENTS, type ProdElResult } from "./lib/compose-prod-elements";
import { runComposeProdDaily } from "./lib/compose-prod-daily-db";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Math.min(14, Math.max(1, Number(arg("days", "7")))), SHOW = Number(arg("show", "0"));
const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date()));
if (jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force")) { console.log(`営業時間（JST ${jstHour}時）は回さない（22時以降に）`); process.exit(0); }
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const line = (x: { id: number; at: string; r: ProdElResult[] }) => `#${x.id} ${x.at.slice(5, 10)} ${x.r.map((y) => `${y.el}${y.has ? (y.hit ? "○" : "×") : "-"}`).join(" ")}｜${x.r.filter((y) => y.has && !y.hit).map((y) => `${y.el}:${y.detail}`).join(" ／ ")}`;

async function main() {
  const started = new Date().toISOString();
  const { before, after } = await runComposeProdDaily(sb, DAYS);
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
  console.log(`竹内さん本人の返信の番（下書きあり）: 前の${DAYS}日 ${before.turns}・今の${DAYS}日 ${after.turns}`);
  console.log("要素｜今（当たり/竹内さんの文にある番）｜前");
  for (const e of PROD_ELEMENTS) console.log(`${e}｜${after.tally[e].hit}/${after.tally[e].has}（${pct(after.tally[e].hit, after.tally[e].has)}）｜${before.tally[e].hit}/${before.tally[e].has}（${pct(before.tally[e].hit, before.tally[e].has)}）`);
  if (SHOW && process.argv.includes("--before")) for (const x of before.results.slice(0, SHOW)) console.log(`前 ${line(x)}`);
  if (SHOW) for (const x of after.results.slice(0, SHOW)) console.log(line(x));
  if (process.argv.includes("--write")) {
    const { error } = await sb.from("cron_run_logs").insert({ cron_name: "compose-prod-daily", started_at: started, finished_at: new Date().toISOString(), ok: true, result_json: { days: DAYS, turns: { before: before.turns, after: after.turns }, before: before.tally, after: after.tally } });
    console.log(error ? `cron_run_logs に書けない: ${error.message}` : "cron_run_logs に1行書いた");
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
