// scripts/exam-spend-day.ts — 1日の試験の費用（読むだけ・LLM なし）。前を作る子（script:brain-exam-main-*）も入れ、DeepSeek は表の単価（平日の倍の時間は2倍・app/lib/llm-price.ts）で数える
//   2026-11-05 作業員8（統括役「5つの直しの後の1日の試験の費用を、前（約 $39/日）と比べて」）。llm_usage_daily の est_usd は DeepSeek にも Sonnet の式を掛けていた（弱い所 310）ので使わない
// 実行: npx tsx --env-file=.env.local scripts/exam-spend-day.ts [--day=2026-11-06]（JST の日・既定 昨日）
import { createClient } from "@supabase/supabase-js";
import { altUsageUsd, altPriceOf } from "../app/lib/llm-price";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { planVsActualReport, type PlanVsActual } from "./lib/exam-plan";

/** 2026-11-06 統括役: その日に積んだ依頼の見込み（exam-plans.jsonl）と実際（作業ツリーの results/<label>.cost.json）の比。ファイルを読むだけ（DB を読まない） */
function planVsActualOf(dayJst: string): PlanVsActual[] {
  const C = examCacheRoot(), Q = join(C, "exam-queue");
  const plans = new Map<string, { at: string; usd: number; stage: string; route: string }>();
  try { for (const l of readFileSync(join(C, "exam-plans.jsonl"), "utf8").split("\n")) { try { const j = JSON.parse(l); plans.set(j.label, j); } catch { /* */ } } } catch { return []; }
  const jobs = new Map<string, { cwd: string }>();
  for (const d of [join(Q, "done"), Q]) { try { for (const f of readdirSync(d)) { if (!/\.json$/.test(f)) continue; try { const j = JSON.parse(readFileSync(join(d, f), "utf8")); if (j.label && j.cwd) jobs.set(j.label, j); } catch { /* */ } } } catch { /* */ } }
  const out: PlanVsActual[] = [];
  for (const [label, p] of plans) {
    if (p.route !== "exam" || new Date(Date.parse(p.at) + 9 * 3_600_000).toISOString().slice(0, 10) !== dayJst) continue;
    const j = jobs.get(label); if (!j) continue;
    const res = join(j.cwd, "scripts", "brain-exam", "results");
    const cf = join(res, `${label}.cost.json`); if (!existsSync(cf)) continue;
    try {
      const c = JSON.parse(readFileSync(cf, "utf8"));
      const rf = join(res, `${label}.jsonl`);
      const reps = existsSync(rf) ? readFileSync(rf, "utf8").split("\n").filter(Boolean).length : 0;
      out.push({ label, stage: String(c.stage ?? p.stage), planUsd: p.usd, cur: (c.total?.realUsd ?? 0) + (c.total?.replayUsd ?? 0), judge: c.judge?.usd ?? 0, base: c.baseline?.childUsd ?? 0, reps });
    } catch { /* */ }
  }
  return out;
}

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const yest = new Date(Date.now() + 9 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
const day = arg("day", yest);
const from = new Date(Date.parse(`${day}T00:00:00+09:00`)).toISOString(), to = new Date(Date.parse(`${day}T00:00:00+09:00`) + 86_400_000).toISOString();
/** Claude（Sonnet 5.x）の式（llm_usage_daily と同じ: 入力 $2・読み $0.2・書き 5m $2.5・1h $4・出力 $10 /M） */
const claudeUsd = (r: Row) => ((r.input_uncached ?? 0) * 2 + (r.cache_read ?? 0) * 0.2 + (r.cache_write_5m ?? 0) * 2.5 + (r.cache_write_1h ?? 0) * 4 + (r.output_tokens ?? 0) * 10) / 1e6;
type Row = { route: string | null; model: string | null; input_uncached: number | null; cache_read: number | null; cache_write_5m: number | null; cache_write_1h: number | null; output_tokens: number | null; created_at: string; status: number | null };
(async () => {
  const rows: Row[] = [];
  for (let i = 0; ; i += 1000) { // 1000行ずつの頁（点検表 3）
    const { data, error } = await sb.from("llm_usage_logs").select("route, model, input_uncached, cache_read, cache_write_5m, cache_write_1h, output_tokens, created_at, status")
      .gte("created_at", from).lt("created_at", to).like("route", "script:%").order("id", { ascending: true }).range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  const g = new Map<string, { n: number; usd: number }>();
  const add = (k: string, usd: number) => { const v = g.get(k) ?? { n: 0, usd: 0 }; v.n++; v.usd += usd; g.set(k, v); };
  for (const r of rows) {
    if (!(r.status != null && r.status >= 1 && r.status < 400)) continue;
    const grp = /^script:brain-exam-main-/.test(r.route ?? "") ? "前を作る子" : /^script:brain-exam/.test(r.route ?? "") ? "依頼" : "他の台本";
    const isClaude = /^claude/.test(r.model ?? "");
    add(`${grp}|${isClaude ? "Claude" : altPriceOf(r.model) ? "DeepSeek・Jev" : "他"}`, isClaude ? claudeUsd(r) : altUsageUsd(r));
  }
  const tot = [...g.values()].reduce((s, v) => s + v.usd, 0);
  console.log(`# ${day}（JST）の試験の費用（llm_usage_logs・route=script:*・DeepSeek は表の単価・倍の時間は2倍）: 合計 $${tot.toFixed(2)}（前 11/04〜05 は 約 $39/日）`);
  for (const [k, v] of [...g].sort((a, b) => b[1].usd - a[1].usd)) console.log(`- ${k.replace("|", "・")}: ${v.n}回 $${v.usd.toFixed(2)}`);
  // 見込みと実際の比（依頼ごと・段ごと）。比の中央が 0.7〜1.3 を外れた段は exam-plan.ts の単価（BRAIN_USD_PER_REP・DRAFT_USD_PER_REP）を直す
  const pv = planVsActualReport(planVsActualOf(day));
  if (pv.lines.length) {
    console.log(`\n## 見込みと実際（${pv.lines.length}本）`);
    for (const l of pv.lines) console.log(l);
    for (const [st, v] of Object.entries(pv.byStage)) console.log(`- 段 ${st}: ${v.n}本・1回あたり（今＋判定）${v.perRep.toFixed(3)}・比の中央 ${v.ratioMid.toFixed(2)}${v.ratioMid < 0.7 || v.ratioMid > 1.3 ? " ⚠ 単価を直す" : ""}`);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
