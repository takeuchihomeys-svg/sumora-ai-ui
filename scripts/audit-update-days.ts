// scripts/audit-update-days.ts（読むだけ・書かない）
// 2026-09-29 v2.5.41 竹内「更新日もちゃんと確認する。更新日を生かすことによって最新の物件の検索や新規物件のもれがないようにするのが目的」
//   ①保存済みの点検（search_audits）の UPDATE_DAYS の札を、今の決まり（命令の payload・計画・伏せ字の写しは言わない）で当て直して前後を数える
//   ②前回の検索（同じお客様×サイトで最後に終わった回）から空いた時間を、その回の更新日で覆えていたか（漏れの穴の実例）
//   ③その回に今の計画（search-update-days.planUpdateDays）を当てたら何日になっていたか
// 実行: npx tsx --env-file=.env.local scripts/audit-update-days.ts [--since=2026-09-22] [--show=25]
import { createClient } from "@supabase/supabase-js";
import { runSearchAuditChecks, type AuditInput } from "../app/lib/search-audit-check";
import { hoursSince, neededDays, planUpdateDays, fmtGap } from "../app/lib/search-update-days";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const since = arg("since", "2026-09-22");
const show = Number(arg("show", "25"));

type Row = {
  run_id: string; created_at: string; status: string; site: string | null; trigger: string | null; command_id: string | null; is_wide: boolean | null;
  area_mode: string | null; property_customer_id: string | null; customer_snapshot: Record<string, unknown> | null; intended: Record<string, unknown> | null;
  filled: Record<string, unknown> | null; steps: unknown; result: Record<string, unknown> | null; error: string | null; error_kind: string | null; checks: Array<{ code: string; severity: string; cause_key: string; detail?: string }> | null;
};

(async () => {
  const lookback = new Date(Date.parse(since) - 30 * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let off = 0; off < 20000; off += 1000) {
    const { data, error } = await sb.from("search_audits").select("run_id, created_at, status, site, trigger, command_id, is_wide, area_mode, property_customer_id, customer_snapshot, intended, filled, steps, result, error, error_kind, checks")
      .gte("created_at", lookback).order("created_at").range(off, off + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const cmdIds = [...new Set(rows.map((r) => r.command_id).filter(Boolean))] as string[];
  const payloads = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < cmdIds.length; i += 100) {
    const { data } = await sb.from("automation_commands").select("id, payload").in("id", cmdIds.slice(i, i + 100));
    for (const c of (data ?? []) as Array<{ id: string; payload: Record<string, unknown> | null }>) if (c.payload) payloads.set(String(c.id), c.payload);
  }
  const done = (r: Row) => r.status === "finished" && !r.error && !r.error_kind && !(r.result?.batch_timed_out) && !(r.result?.fill_timed_out);
  const lastBefore = (r: Row) => {
    let best: string | null = null;
    for (const x of rows) {
      if (x.created_at >= r.created_at) break;
      if (x.property_customer_id === r.property_customer_id && x.site === r.site && done(x)) best = x.created_at;
    }
    return best;
  };
  const target = rows.filter((r) => r.created_at >= since && (r.site === "realpro" || r.site === "itandi") && r.status === "finished");
  const before: Record<string, number> = {}, after: Record<string, number> = {};
  const gaps: string[] = [];
  let widenN = 0, gapN = 0, withLast = 0;
  const widenEx: string[] = [];
  for (const r of target) {
    for (const c of r.checks ?? []) if (c.code === "UPDATE_DAYS" && c.severity !== "ok") before[c.cause_key] = (before[c.cause_key] ?? 0) + 1;
    const last = lastBefore(r);
    if (last) withLast++;
    const input: AuditInput = {
      site: r.site, status: r.status, trigger: r.trigger, is_wide: r.is_wide, area_mode: r.area_mode, customer_snapshot: r.customer_snapshot as never,
      intended: r.intended as never, filled: r.filled as never, steps: r.steps as never, result: r.result as never, error: r.error, error_kind: r.error_kind,
      created_at: r.created_at, command_payload: r.command_id ? payloads.get(String(r.command_id)) ?? null : null, last_search_at: last, customer_id: r.property_customer_id,
    };
    const v = runSearchAuditChecks(input, Date.parse(r.created_at));
    for (const c of v.checks) if (c.code === "UPDATE_DAYS" && c.severity !== "ok") after[c.cause_key] = (after[c.cause_key] ?? 0) + 1;
    for (const c of v.checks) if (/:differs$|:cut_by_pages$/.test(c.cause_key) && (process.argv.includes("--detail"))) console.log("  [" + c.cause_key.split(":")[2] + "] " + r.created_at.slice(0, 16) + " " + r.trigger + " " + (r.command_id ? String(payloads.get(String(r.command_id))?.source ?? "-") + "/" + String(payloads.get(String(r.command_id))?.mode ?? "-") : "-") + " " + c.detail);
    const gap = v.checks.find((c) => c.cause_key.endsWith(":gap_uncovered"));
    if (gap) { gapN++; if (gaps.length < show) gaps.push(`${r.created_at.slice(0, 16)} ${r.site} ${r.trigger} ${String(r.property_customer_id).slice(0, 8)} ${gap.detail}`); }
    const days = r.intended?.rp_update_days;
    const base = typeof days === "number" ? days : null;
    const plan = planUpdateDays({ baseDays: base, lastSearchAt: last, nowMs: Date.parse(r.created_at) });
    if (plan.widened) { widenN++; if (widenEx.length < 10) widenEx.push(`${r.created_at.slice(0, 16)} ${r.site} ${String(r.property_customer_id).slice(0, 8)} 入れた ${base ?? "指定なし"} → 計画 ${plan.days ?? "指定なし"}（前回 ${last?.slice(0, 16)}・${fmtGap(hoursSince(last, Date.parse(r.created_at)))}・要る ${neededDays(hoursSince(last, Date.parse(r.created_at)))}日）`); }
  }
  console.log(`=== 更新日の当て直し（${since}〜・点検 ${target.length}回・前回の検索が分かる ${withLast}回） ===`);
  console.log("旧の札:", before);
  console.log("今の札:", after);
  console.log(`\n前回の検索から空いた分を覆えていなかった回（gap_uncovered）: ${gapN}回`);
  for (const g of gaps) console.log("  " + g);
  console.log(`\n今の計画なら広げていた回: ${widenN}回`);
  for (const w of widenEx) console.log("  " + w);
})().catch((e) => { console.error(e); process.exit(1); });
