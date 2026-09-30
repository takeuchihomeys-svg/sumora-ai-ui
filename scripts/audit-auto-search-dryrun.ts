// scripts/audit-auto-search-dryrun.ts（読むだけ・DB に書かない・命令を積まない）
// 2026-09-30 自動便の cron（/api/cron/auto-property-search）の dry_run と同じ組み立てを、本番の今の材料で純関数に当てて表にする:
//   誰を（状態・午後は今日の候補0件の理由）・どの並び・更新日（前回の検索からの空きで広げた後）・止める線（サイトごとの前回の検索）・ページ・
//   not_before と「1人ずつ順に拾った時の見積もりの開始／終わり」（1人あたりの分は --per=分・既定 午前 8.5・午後 6.5＝ITANDI の入力と資料が大半）。
//   未実行・実行中の命令がある人は cron と同じく積まない（午前の続きを待つ）。
// 実行: npx tsx --env-file=.env.local scripts/audit-auto-search-dryrun.ts --mode=pm [--at=2026-09-30T16:00:00+09:00] [--limit=60] [--per=6.5] [--ignore-open（今の未実行の命令を見ない＝明日の見積もり）]
import { createClient } from "@supabase/supabase-js";
import { loadStateInputs } from "../app/lib/auto-search-plan-server";
import { selectPlannedTargets, planEnv, STATE_JA } from "../app/lib/auto-search-plan";
import { planUpdateDaysFor } from "../app/lib/search-update-days-server";
import { MAX_TARGETS_PER_RUN, AUTO_SEARCH_SITES, notBeforeSchedule, autoStartAtMs, type AutoSearchMode } from "../app/lib/auto-search-schedule";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const jst = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(11, 16);

async function main() {
  const mode = (arg("mode") === "am" ? "am" : "pm") as AutoSearchMode;
  const nowMs = arg("at") ? Date.parse(arg("at")!) : Date.now();
  const jstDate = new Date(nowMs + 9 * 3600_000).toISOString().slice(0, 10);
  const limit = Number(arg("limit") ?? MAX_TARGETS_PER_RUN);
  const per = Number(arg("per") ?? (mode === "am" ? 8.5 : 6.5));
  const { data, error } = await sb.from("property_customers").select("id, customer_name, status, created_at, desired_area, area").limit(1000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; customer_name: string | null; status: string | null; created_at: string | null; desired_area: string | null; area: string | null }>;
  const withCond = rows.filter((r) => !!(r.desired_area || r.area));
  const inputs = await loadStateInputs(sb, withCond, nowMs);
  const env = planEnv();
  const sel = selectPlannedTargets(inputs, mode, jstDate, nowMs, { limit, stopAtLast: env.stopAtLast });
  const { data: open } = await sb.from("automation_commands").select("customer_ids, payload").in("status", ["pending", "running"]).limit(500);
  const openIds = new Set<string>();
  if (!process.argv.includes("--ignore-open")) for (const r of (open ?? []) as Array<{ customer_ids: string[] | null }>) for (const id of r.customer_ids ?? []) openIds.add(String(id));
  const toQueue = sel.targets.filter((t) => !openIds.has(t.id));
  const waiting = sel.targets.filter((t) => openIds.has(t.id));
  const plans = new Map((await planUpdateDaysFor(sb, toQueue.map((t) => ({ id: t.id, baseDays: t.plan.days })), AUTO_SEARCH_SITES, nowMs)).map((e) => [e.id, e.plan]));
  const nb = new Map(notBeforeSchedule(mode, jstDate, toQueue.map((t) => t.id)).map((x) => [x.id, x.notBeforeMs]));
  const name = (id: string) => (rows.find((r) => r.id === id)?.customer_name ?? "?").slice(0, 1) + "様";
  const pass = new Map(inputs.map((i) => [i.id, i.pass_today]));

  console.log(`\n■ ${jstDate} ${mode === "am" ? "午前" : "午後"}の便（${jst(nowMs)} の材料・上限 ${limit}・開始 ${jst(autoStartAtMs(mode, jstDate))}・1人 ${per}分で見積もり）`);
  console.log(`  状態の内訳: ${JSON.stringify(Object.fromEntries(Object.entries(sel.byState).map(([k, v]) => [STATE_JA[k as keyof typeof STATE_JA], v])))}`);
  const why: Record<string, number> = {};
  for (const x of sel.notThisRun) why[x.why.replace(/\d+件/, "N件")] = (why[x.why.replace(/\d+件/, "N件")] ?? 0) + 1;
  console.log(`  この便で回さない ${sel.notThisRun.length}人: ${JSON.stringify(why)}`);
  console.log(`  上限で落ちた ${sel.overLimit.length}人・未実行／実行中の命令があって待つ（午前の続き） ${waiting.length}人・積む ${toQueue.length}人`);
  let t = autoStartAtMs(mode, jstDate);
  const lines: string[] = [];
  toQueue.forEach((x, k) => {
    const p = plans.get(x.id);
    const start = Math.max(t, nb.get(x.id) ?? t);
    t = start + per * 60_000;
    const lbs = p?.last_by_site ? Object.entries(p.last_by_site).map(([s, v]) => `${s === "realpro" ? "RP" : "IT"}${jst(Date.parse(v))}`).join("/") : "-";
    lines.push([String(k + 1).padStart(2), name(x.id), x.id.slice(0, 8), STATE_JA[x.state], x.plan.sort === "ad" ? "AD順" : "更新順",
      `更新日${p ? p.days ?? "指定なし" : x.plan.days}`, x.plan.stop_at_last ? `止める線 ${lbs}` : "線なし", `${x.plan.max_pages}p`,
      `nb ${jst(nb.get(x.id)!)}`, `見積 ${jst(start)}〜${jst(t)}`, x.runReason ?? "", mode === "pm" ? `今日の候補${pass.get(x.id) ?? "?"}` : ""].join(" | "));
  });
  console.log(lines.join("\n"));
  console.log(`  見積もりの終わり: ${jst(t)}（${toQueue.length}人 × ${per}分・人の間込み）`);
  if (waiting.length) console.log(`  待つ人: ${waiting.map((x) => `${name(x.id)}(${x.id.slice(0, 8)})`).join(" ")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
