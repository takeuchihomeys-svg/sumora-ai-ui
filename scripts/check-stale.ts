// scripts/check-stale.ts — 穴の型①「作ったのに回っていない」の点検（読むだけ・LLM なし・費用0・作業員N・2026-11-21・台帳 #505）
//
// 統括役 11/21（竹内さん「他に土台として弱い部分があれば強化する そして細部も強化する」）。決めは scripts/lib/stale-runs.ts。
//   cron: vercel.json の予定ごとに cron_run_logs の最後の1行（cron_name・started_at の索引で1本ずつ・limit 1）
//   毎日の数: 期待する metric（毎朝の1枚が書く物＋土台の表の metric＋台本が手元か main にある K2・G の数）ごとに quality_daily の最後の日（metric・day の索引・limit 1）
//   --write … 穴を台帳（work_items・origin=found_gap）に持ち主つきで足す（題で重ねない）
// 実行: npx tsx --env-file=.env.local scripts/check-stale.ts [--json] [--write]
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { staleCronsOf, staleMetricsOf, cronNameOf, type Stale } from "./lib/stale-runs";
import { FOUNDATION_N } from "./lib/foundation-table";
import { inOriginMain } from "./check-foundation";

const jstDay = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const has = (p: string) => existsSync(p) || inOriginMain(p);

/** 期待する毎日の数（末尾 % は前方一致） */
export function expectedMetrics(): Array<{ metric: string; owner: string }> {
  const out: Array<{ metric: string; owner: string }> = [
    ...["reply_match", "aix_first_match", "core:linkage", "core:foundation", "core:subdivide", "core:conductor", "core:window_miss", "core:count_unverified", "core:off_path", "core:conductor_lessons", "core:lessons_read", "growth:first_move:%", "growth:combo:組の一致", "found:full"].map((metric) => ({ metric, owner: "作業員N" })),
    ...FOUNDATION_N.filter((r) => r.metric).map((r) => ({ metric: r.metric!, owner: r.owner.split("・")[0] })),
  ];
  if (has("scripts/audit-appeal-vs-codes.ts")) out.push({ metric: "growth:pickup_via_tool", owner: "作業員K2" });
  if (has("scripts/audit-estimate-done-unsent.ts")) out.push({ metric: "growth:estimate:done_unsent", owner: "作業員K2" }, { metric: "growth:estimate:dup", owner: "作業員K2" });
  if (has("scripts/image-field-fill-daily.ts")) out.push({ metric: "image_fill:%", owner: "作業員G" });
  return [...new Map(out.map((x) => [x.metric, x])).values()];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function checkStale(sb: any, nowMs = Date.now()): Promise<{ stale: Stale[]; crons: number; metrics: number }> {
  const crons = (JSON.parse(readFileSync("vercel.json", "utf8")).crons ?? []) as Array<{ path: string; schedule: string }>;
  const names = [...new Set(crons.map((c) => cronNameOf(c.path)).filter((x): x is string => !!x))];
  const lastByName = new Map<string, string | null>();
  for (const n of names) {
    const { data, error } = await sb.from("cron_run_logs").select("started_at").eq("cron_name", n).order("started_at", { ascending: false }).limit(1);
    if (!error) lastByName.set(n, ((data ?? []) as Array<{ started_at: string }>)[0]?.started_at ?? null);
  }
  const exp = expectedMetrics();
  const lastDay = new Map<string, string | null>();
  for (const e of exp) {
    const q = sb.from("quality_daily").select("day");
    const { data, error } = await (e.metric.endsWith("%") ? q.like("metric", e.metric) : q.eq("metric", e.metric)).order("day", { ascending: false }).limit(1);
    if (!error) lastDay.set(e.metric, ((data ?? []) as Array<{ day: string }>)[0]?.day ?? null);
  }
  const stale = [...staleCronsOf(crons, lastByName, nowMs), ...staleMetricsOf(exp.filter((e) => lastDay.has(e.metric)), lastDay, jstDay(nowMs))];
  return { stale, crons: lastByName.size, metrics: lastDay.size };
}

const KIND_JA: Record<Stale["kind"], string> = { cron_never: "cron の記録が一度も無い（cron-logger を通していない疑い）", cron_stale: "cron が止まっている", metric_never: "毎日の数が一度も無い", metric_stale: "毎日の数が止まっている" };

if (process.argv[1]?.endsWith("check-stale.ts")) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const r = await checkStale(sb);
  if (process.argv.includes("--json")) { console.log(JSON.stringify(r)); return; }
  console.log(`作ったのに回っていない（cron ${r.crons}本・毎日の数 ${r.metrics}種を見た・穴 ${r.stale.length}）`);
  for (const s of r.stale) console.log(`- ${KIND_JA[s.kind]}｜${s.name}｜最後 ${s.last ?? "—"}｜${s.owner}｜${s.why}`);
  if (process.argv.includes("--write")) {
    const { data: open } = await sb.from("work_items").select("title").eq("origin", "found_gap").not("stage", "in", "(done,dropped)").limit(3000);
    const have = new Set(((open ?? []) as Array<{ title: string }>).map((x) => x.title));
    let added = 0;
    // cron の記録が一度も無い物は1行にまとめる（回っていないのか記録しないだけかは、Vercel の実行の記録で確かめる＝穴の型②に近い）
    const never = r.stale.filter((s) => s.kind === "cron_never");
    const items: Stale[] = [...r.stale.filter((s) => s.kind !== "cron_never"), ...(never.length ? [{ kind: "cron_never" as const, name: `${never.length}本`, last: null, expectHours: 24, owner: "統括役", why: `cron_run_logs に1度も無い: ${never.map((x) => x.name).join("・")}` }] : [])];
    for (const s of items) {
      const title = `作ったのに回っていない: ${s.name}（${KIND_JA[s.kind]}）`;
      if (have.has(title)) continue;
      const { data: ins } = await sb.from("work_items").insert({ title, origin: "found_gap", stage: "todo", area: "土台", owner: s.owner, priority: 10, next_step: `check-stale（穴の型①）で見つけた・${s.why}・回す所を確かめて直す（台帳 #505）` }).select("id").single();
      if (ins) { added++; await sb.from("work_item_events").insert({ item_id: (ins as { id: number }).id, to_stage: "todo", actor: "check-stale", kind: "assign", note: `持ち主 ${s.owner}・#505 の子` }); }
    }
    console.log(`台帳に足した ${added}行`);
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
