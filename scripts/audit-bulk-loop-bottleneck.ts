/**
 * 一括ループのボトルネック調査（読むだけ・DB に書かない・LLM なし）2026-11-26
 * 実行: npx tsx --env-file=.env.local scripts/_tmp-loop-bottleneck.ts [--days=3]
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const days = Number(arg("days", "3"));

type Step = { k: string; d?: string; at?: number };
type Row = { id: number; run_id: string; created_at: string; status: string | null; trigger: string | null; ext_version: string | null; cause_key: string | null; steps: Step[] | null; result: Record<string, unknown> | null; error: string | null };

(async () => {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let from = 0; ; from += 200) {
    const { data, error } = await sb
      .from("search_audits")
      .select("id, run_id, created_at, status, trigger, ext_version, cause_key, steps, result, error")
      .eq("site", "realpro")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .range(from, from + 199);
    if (error) { console.log("読めません:", error.message); return; }
    if (!data || !data.length) break;
    rows.push(...(data as Row[]));
    if (data.length < 200) break;
  }
  console.log(`リアプロの点検 ${rows.length} 件（直近${days}日）`);
  const cnt = (f: (r: Row) => string) => { const m = new Map<string, number>(); rows.forEach((r) => m.set(f(r), (m.get(f(r)) || 0) + 1)); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  console.log("\n■ status:", JSON.stringify(cnt((r) => String(r.status))));
  console.log("■ trigger:", JSON.stringify(cnt((r) => String(r.trigger))));
  console.log("■ ext_version:", JSON.stringify(cnt((r) => String(r.ext_version))));
  console.log("■ cause_key:", JSON.stringify(cnt((r) => String(r.cause_key))));

  // ステップ名の出現
  const stepCount = new Map<string, number>();
  rows.forEach((r) => (r.steps || []).forEach((s) => stepCount.set(s.k, (stepCount.get(s.k) || 0) + 1)));
  const interesting = ["reset_press", "reset_verified", "reset_count_same", "reset_not_empty", "reset_fallback", "reset_before_fill", "look_skip", "reset_stuck_shot", "reset_retry", "post_send_clear", "handoff_loop", "bulk_pos", "series_done", "loop_advance", "stuck_shot_req", "stuck_best_act", "stuck_recover_retry", "sort_cursor_insurance", "sort_failed_wait_retry", "bulk_kick", "pipeline_silence", "abandon", "stale_prev_lock_dropped", "switch_timeout", "server_behind", "ext_behind"];
  console.log("\n■ 印の出現数:", interesting.map((k) => `${k}=${stepCount.get(k) || 0}`).join(" "));

  // 1回ごとの所要と最長の沈黙
  const gapByKey = new Map<string, { n: number; sum: number; max: number }>();
  const durations: number[] = [];
  const longRuns: { id: number; ver: string | null; status: string | null; dur: number; maxGap: number; before: string; after: string }[] = [];
  rows.forEach((r) => {
    const st = (r.steps || []).filter((s) => typeof s.at === "number").sort((a, b) => (a.at as number) - (b.at as number));
    if (st.length < 2) return;
    const dur = (st[st.length - 1].at as number) - (st[0].at as number);
    durations.push(dur);
    let mg = 0, bk = "", ak = "";
    for (let i = 1; i < st.length; i++) {
      const g = (st[i].at as number) - (st[i - 1].at as number);
      const key = st[i - 1].k;
      const e = gapByKey.get(key) || { n: 0, sum: 0, max: 0 };
      e.n++; e.sum += g; e.max = Math.max(e.max, g); gapByKey.set(key, e);
      if (g > mg) { mg = g; bk = st[i - 1].k; ak = st[i].k; }
    }
    longRuns.push({ id: r.id, ver: r.ext_version, status: r.status, dur, maxGap: mg, before: bk, after: ak });
  });
  durations.sort((a, b) => a - b);
  const q = (p: number) => durations.length ? Math.round(durations[Math.min(durations.length - 1, Math.floor(durations.length * p))] / 1000) : 0;
  console.log(`\n■ 1回の所要（秒）: 件数${durations.length} 中央${q(0.5)} p90=${q(0.9)} 最大=${q(1)}`);
  console.log("\n■ 「この印のあとに空いた時間」合計の大きい順（上位14）");
  [...gapByKey.entries()].sort((a, b) => b[1].sum - a[1].sum).slice(0, 14).forEach(([k, v]) => console.log(`  ${k.padEnd(28)} 回数${String(v.n).padStart(5)} 合計${String(Math.round(v.sum / 1000)).padStart(7)}秒 最大${String(Math.round(v.max / 1000)).padStart(5)}秒 平均${Math.round(v.sum / v.n / 1000)}秒`));
  console.log("\n■ 最長の沈黙が長かった回（上位10）");
  longRuns.sort((a, b) => b.maxGap - a.maxGap).slice(0, 10).forEach((l) => console.log(`  #${l.id} ver=${l.ver} ${l.status} 所要${Math.round(l.dur / 1000)}秒 最長沈黙${Math.round(l.maxGap / 1000)}秒 ${l.before} → ${l.after}`));

  // 放棄の詳細（なぜ終わらなかったか）
  const ab = rows.filter((r) => r.status === "abandoned" || r.status === "error" || r.status === "timeout");
  console.log(`\n■ 完了しなかった回 ${ab.length} 件。最後の印の出現数（上位12）`);
  const last = new Map<string, number>();
  ab.forEach((r) => { const st = (r.steps || []); const k = st.length ? st[st.length - 1].k : "(なし)"; last.set(k, (last.get(k) || 0) + 1); });
  [...last.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, n]) => console.log(`  ${k}: ${n}`));
  console.log("\n■ 直近の15件（id・ver・trigger・status・cause・所要）");
  rows.slice(-15).forEach((r) => {
    const st = (r.steps || []).filter((s) => typeof s.at === "number");
    const dur = st.length > 1 ? Math.round(((st[st.length - 1].at as number) - (st[0].at as number)) / 1000) : 0;
    console.log(`  #${r.id} ${r.created_at.slice(5, 16)} ${r.ext_version} ${r.trigger} ${r.status} cause=${r.cause_key} ${dur}秒 steps=${(r.steps || []).length}`);
  });
})();
