// scripts/compose-prod-daily.ts — 文の当たりを本番で毎日数える（読むだけ・LLM なし・費用0・2026-11-15 作業員H・統括役の頼み②）
//   竹内さん本人の実送信（line_watch_turns.staff_texts・書き手は messages.staff_writer＝takeuchi・AIX でない返信）と、その番の下書き（draft_last）を、
//   文の要素ごと（頭・押さえ・信頼・潜在・つなぎ・締め・事実・2通目）に比べる（scripts/lib/compose-prod-elements.ts・読みは scripts/lib/compose-prod-daily-db.ts）。
//   毎朝の cron は app/api/cron/compose-prod-daily（同じ読み・cron_run_logs に残す）。ここは手元の確かめ（--show で番ごと・--before で前の窓も）
//   --write で cron_run_logs に1行（cron_name=compose-prod-daily）。営業時間（JST 9〜22時）は回さない（--force で手元の確かめだけ）
//   2026-11-19 作業員H（統括役の頼み・竹内さん本人の番は7日で6番しかなく直しの効きが測れない）:
//     --writers=all（AIX でないスタッフの返信全部）・--writers=takeuchi,<名前>（その書き手だけ）。既定は takeuchi（今まで通り・cron も同じ）
//     --fix=<名前>@<日時>（何個でも・日時は ISO・時差なしは JST）: 直した物ごとに on の前と後の窓（同じ長さ・最大 --days 日・6時間未満は「まだ」）で比べる
//   使い方: npx tsx --env-file=<.env.local> scripts/compose-prod-daily.ts [--days=7] [--writers=all] [--fix=SENT_SHAPE_NANITOZO_LEN@2026-11-19T01:40] [--write] [--force] [--show=10] [--before]
import { createClient } from "@supabase/supabase-js";
import { PROD_ELEMENTS, type ProdElResult, type ProdTally } from "./lib/compose-prod-elements";
import { runComposeProdDaily, runProdAroundFixes, type ProdWindow } from "./lib/compose-prod-daily-db";
import { parseWriters, parseFix, writersLabel, type FixSpec } from "./lib/compose-prod-window";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Math.min(14, Math.max(1, Number(arg("days", "7")))), SHOW = Number(arg("show", "0"));
const WRITERS = parseWriters(arg("writers", ""));
const FIX_ARGS = process.argv.filter((a) => a.startsWith("--fix=")).map((a) => a.slice(6));
const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date()));
if (jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force")) { console.log(`営業時間（JST ${jstHour}時）は回さない（22時以降に）`); process.exit(0); }
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const line = (x: { id: number; at: string; writer?: string | null; r: ProdElResult[] }) => `#${x.id} ${x.at.slice(5, 10)}${x.writer !== undefined ? ` ${x.writer ?? "(不明)"}` : ""} ${x.r.map((y) => `${y.el}${y.has ? (y.hit ? "○" : "×") : "-"}`).join(" ")}｜${x.r.filter((y) => y.has && !y.hit).map((y) => `${y.el}:${y.detail}`).join(" ／ ")}`;
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const cell = (t: ProdTally, e: typeof PROD_ELEMENTS[number]) => `${t[e].hit}/${t[e].has}（${pct(t[e].hit, t[e].has)}）`;
const writersOf = (w: ProdWindow) => Object.entries(w.byWriter).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("・") || "-";

async function main() {
  const started = new Date().toISOString();
  const fixes: FixSpec[] = [];
  for (const v of FIX_ARGS) { const f = parseFix(v); if ("error" in f) console.warn(`⚠ ${f.error}`); else fixes.push(f); }
  if (fixes.length) {
    // 直した物ごとの前後（この時は毎日の窓は出さない）
    const rs = await runProdAroundFixes(sb, fixes, DAYS, Date.now(), WRITERS);
    for (const r of rs) {
      const at = new Date(r.fix.atMs).toISOString();
      if ("notYet" in r) { console.log(`\n== ${r.fix.name}（on ${at}）: 後の窓が6時間に満たない＝まだ測れない`); continue; }
      console.log(`\n== ${r.fix.name}（on ${at}・前と後 ${r.spanH}時間ずつ・${writersLabel(WRITERS)}）: 番 前 ${r.before.turns}（${writersOf(r.before)}）→ 後 ${r.after.turns}（${writersOf(r.after)}）`);
      console.log("要素｜後｜前");
      for (const e of PROD_ELEMENTS) console.log(`${e}｜${cell(r.after.tally, e)}｜${cell(r.before.tally, e)}`);
      if (SHOW) for (const x of r.after.results.slice(0, SHOW)) console.log(`後 ${line(x)}`);
    }
    if (process.argv.includes("--write")) console.log("（--fix の時は cron_run_logs に書かない）");
    return;
  }
  const { before, after } = await runComposeProdDaily(sb, DAYS, Date.now(), WRITERS);
  console.log(`${writersLabel(WRITERS)}の返信の番（下書きあり）: 前の${DAYS}日 ${before.turns}・今の${DAYS}日 ${after.turns}${WRITERS !== "takeuchi" ? `（今の書き手: ${writersOf(after)}）` : ""}`);
  console.log(`要素｜今（当たり/${WRITERS === "takeuchi" ? "竹内さん" : "スタッフ"}の文にある番）｜前`);
  for (const e of PROD_ELEMENTS) console.log(`${e}｜${cell(after.tally, e)}｜${cell(before.tally, e)}`);
  if (SHOW && process.argv.includes("--before")) for (const x of before.results.slice(0, SHOW)) console.log(`前 ${line(x)}`);
  if (SHOW) for (const x of after.results.slice(0, SHOW)) console.log(line(x));
  if (process.argv.includes("--write")) {
    if (WRITERS !== "takeuchi") { console.log("（--writers を変えた時は cron_run_logs に書かない＝毎朝の数えと混ぜない）"); return; }
    const { error } = await sb.from("cron_run_logs").insert({ cron_name: "compose-prod-daily", started_at: started, finished_at: new Date().toISOString(), ok: true, result_json: { days: DAYS, turns: { before: before.turns, after: after.turns }, before: before.tally, after: after.tally } });
    console.log(error ? `cron_run_logs に書けない: ${error.message}` : "cron_run_logs に1行書いた");
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
