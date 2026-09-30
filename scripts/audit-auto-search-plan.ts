// scripts/audit-auto-search-plan.ts（読むだけ・DB に書かない・命令を積まない）
// v2.5.44 自動便の状態の判定（auto-search-plan）を本番の今日のお客様に当てて、状態の内訳・便ごとの対象・今までの選び方との違いを出す。
// 実行: npx tsx --env-file=.env.local scripts/audit-auto-search-plan.ts [--date=2026-09-30] [--show=10] [--json]
import { createClient } from "@supabase/supabase-js";
import { loadStateInputs } from "../app/lib/auto-search-plan-server";
import { classifyAutoSearchState, selectPlannedTargets, STATE_JA, type AutoSearchState } from "../app/lib/auto-search-plan";
import { selectAutoSearchTargets, lastPropertyTouchAt, jstDaysSince } from "../app/lib/auto-search-schedule";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const sb = createClient(url, key);

async function main() {
  const date = arg("date");
  const nowMs = date ? Date.parse(`${date}T10:00:00+09:00`) : Date.now();
  const jstDate = new Date(nowMs + 9 * 3600_000).toISOString().slice(0, 10);
  const show = Number(arg("show") ?? 10);
  const { data, error } = await sb.from("property_customers")
    .select("id, customer_name, status, last_property_sent_at, property_viewed_at, created_at, desired_area, area, rp_update_days").limit(1000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; customer_name: string | null; status: string | null; last_property_sent_at: string | null; property_viewed_at: string | null; created_at: string | null; desired_area: string | null; area: string | null }>;
  const withCond = rows.filter((r) => !!(r.desired_area || r.area));
  const inputs = await loadStateInputs(sb, withCond, nowMs);
  const name = (id: string) => (rows.find((r) => r.id === id)?.customer_name ?? "?").slice(0, 1) + "様";
  const byState: Record<string, number> = {};
  const states = new Map<string, { state: AutoSearchState; reason: string }>();
  for (const i of inputs) { const s = classifyAutoSearchState(i, nowMs); states.set(i.id, s); byState[STATE_JA[s.state]] = (byState[STATE_JA[s.state]] ?? 0) + 1; }
  console.log(`\n■ ${jstDate}（条件ありのお客様 ${withCond.length}人 / 全 ${rows.length}人）の状態の内訳`);
  console.table(byState);

  // 今までの選び方（last_property_sent_at・確認日で直近3日＋登録3日以内の新規）との突き合わせ
  const legacy = selectAutoSearchTargets(withCond, { nowMs, limit: 1000 });
  const cross: Record<string, Record<string, number>> = {};
  for (const t of legacy) { const s = STATE_JA[states.get(t.id)?.state ?? "off"]; cross[t.reason] ??= {}; cross[t.reason][s] = (cross[t.reason][s] ?? 0) + 1; }
  console.log(`\n■ 今までの選び方の ${legacy.length}人（上限なし）が今の状態で何か`);
  console.table(cross);
  // 汚れの確かめ: last_property_sent_at が直近3日なのに実際の送付が4日以上前
  const dirty = legacy.filter((t) => t.reason === "recent_sent").map((t) => {
    const i = inputs.find((x) => x.id === t.id)!;
    const r = rows.find((x) => x.id === t.id)!;
    return { id: t.id.slice(0, 8), col_days: jstDaysSince(lastPropertyTouchAt(r), nowMs), actual_send_days: jstDaysSince(i.last_proposal_at, nowMs), msg_days: jstDaysSince(i.last_customer_msg_at, nowMs) };
  });
  console.log(`  列は直近3日なのに実際の送付が4日以上前・無い: ${dirty.filter((d) => d.actual_send_days == null || d.actual_send_days >= 4).length} / ${dirty.length}`);

  for (const mode of ["am", "pm"] as const) {
    const sel = selectPlannedTargets(inputs, mode, jstDate, nowMs, { limit: 40 });
    const q: Record<string, number> = {};
    for (const t of sel.targets) q[STATE_JA[t.state]] = (q[STATE_JA[t.state]] ?? 0) + 1;
    const sorts = sel.targets.reduce<Record<string, number>>((m, t) => { m[`${t.plan.sort}${t.plan.stop_at_last ? "+止める線" : ""}`] = (m[`${t.plan.sort}${t.plan.stop_at_last ? "+止める線" : ""}`] ?? 0) + 1; return m; }, {});
    console.log(`\n■ ${mode === "am" ? "午前" : "午後"}の便: 対象 ${sel.targets.length}人・この便で回さない ${sel.notThisRun.length}人・上限で落ちた ${sel.overLimit.length}人`);
    console.table(q);
    console.log("  並び:", JSON.stringify(sorts));
    for (const t of sel.targets.slice(0, show)) console.log(`  ${STATE_JA[t.state]}\t${name(t.id)}\t${t.id.slice(0, 8)}\t${t.plan.sort}\tdays=${t.plan.days}\tstop=${t.plan.stop_at_last}\t${t.stateReason}`);
  }
  // 週2回の人の曜日（今週）
  const dormant = inputs.filter((i) => states.get(i.id)?.state === "dormant");
  const wd = [0, 0, 0, 0, 0, 0, 0];
  const { dormantWeekdays } = await import("../app/lib/auto-search-plan");
  for (const d of dormant) for (const w of dormantWeekdays(jstDate, d.id)) wd[w]++;
  console.log(`\n■ 止まっている ${dormant.length}人の今週の曜日（日〜土）: ${wd.join(" / ")}`);
  if (process.argv.includes("--json")) console.log(JSON.stringify(inputs.map((i) => ({ ...i, id: i.id.slice(0, 8), state: states.get(i.id)?.state })), null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
