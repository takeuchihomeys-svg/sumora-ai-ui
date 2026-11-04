// app/api/cron/rollout-watch/route.ts — 段階で広げたスイッチの夜の見張り（毎晩 JST 3:40・SQL だけ・LLM なし）
//   ROLLOUT_WATCH: off（既定）／dry（決めて Vercel のログに1行出すだけ）／on（悪化なら rollout_overrides に1段下を書き、ops_anomalies に kind=rollout_down の知らせ）
//   判断は app/lib/rollout-watch.ts。env（統括役の決定）は書き換えない＝表の上書きだけ。戻した事は画面の上の印と作業員の表に出る
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { decideRollout, watchedSwitches, isMatchVerdict, isJudgedVerdict, rolloutWatchMode, type GroupRate, type WatchDecision } from "@/app/lib/rollout-watch";
import { stageOf, stageOn, loadRolloutOverrides } from "@/app/lib/rollout";
import { isTestConversation } from "@/app/lib/test-conversations";
import { readRowsUpTo } from "@/app/lib/read-all-rows";

export const maxDuration = 60;
export const dynamic = "force-dynamic";
const DAY = 86_400_000;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const mode = rolloutWatchMode();
  if (mode === "off") return NextResponse.json({ ok: true, skipped: "ROLLOUT_WATCH が on／dry でない" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" }, { status: 500 });
  const db = createClient(url, key, { auth: { persistSession: false } });
  try {
    const names = watchedSwitches(process.env);
    if (!names.length) return NextResponse.json({ ok: true, mode, names: [], note: "pct:N か all の _STAGE が無い" });
    const now = Date.now();
    const overrides = await loadRolloutOverrides(now);
    // 2026-11-04 危ない所の見張り (b): 1回 1000行で黙って切れる読み → readRowsUpTo（READ_ALL_ROWS=on で 1000行ずつ・off は今まで通り）
  const { data: turns, error } = await readRowsUpTo<{ conversation_id: string; customer_turn_at: string; verdict: string | null }>((a, b, paged) => {
    const q = db.from("line_watch_turns").select("conversation_id, customer_turn_at, verdict").gte("customer_turn_at", new Date(now - 14 * DAY).toISOString());
    return (paged ? q.order("id") : q).range(a, b);
  }, 5000);
    if (error) throw new Error(`line_watch_turns: ${error.message}`);
    const judged = ((turns ?? []) as Array<{ conversation_id: string; customer_turn_at: string; verdict: string | null }>).filter((t) => isJudgedVerdict(t.verdict) && !isTestConversation(t.conversation_id));
    const tally = (rows: typeof judged): GroupRate => ({ n: rows.length, match: rows.filter((r) => isMatchVerdict(r.verdict)).length });
    const { data: vers } = await db.from("brain_switch_versions").select("switches, first_seen_at").order("first_seen_at", { ascending: true }).limit(2000);
    const decisions: WatchDecision[] = [];
    for (const name of names) {
      const stage = stageOf(name, process.env, overrides);
      if (stage.kind === "pct") {
        const week = judged.filter((t) => Date.parse(t.customer_turn_at) >= now - 7 * DAY);
        const on = week.filter((t) => stageOn(name, t.conversation_id, process.env, overrides)), off = week.filter((t) => !stageOn(name, t.conversation_id, process.env, overrides));
        decisions.push(decideRollout({ name, stage, on: tally(on), off: tally(off), mode: "pct" }));
      } else if (stage.kind === "all") {
        // all に上がった時: 版の記録で「all を含まない最後の版」の次の版が初めて見えた時刻
        const has = (s: string) => new RegExp(`^${name}_STAGE=all$|^${name}=on$`, "m").test(s);
        const vs = (vers ?? []) as Array<{ switches: string; first_seen_at: string }>;
        let lastWithout = -1; vs.forEach((v, i) => { if (!has(v.switches)) lastWithout = i; });
        const changeAt = lastWithout >= 0 && vs[lastWithout + 1] ? Date.parse(vs[lastWithout + 1].first_seen_at) : null;
        if (!changeAt || now - changeAt > 7 * DAY) { decisions.push({ name, action: "keep", from: "all", why: changeAt ? "all に上がって7日より前（前後比べはしない）" : "all に上がった時が版の記録に無い", dropPt: null }); continue; }
        const after = judged.filter((t) => Date.parse(t.customer_turn_at) >= changeAt), before = judged.filter((t) => { const x = Date.parse(t.customer_turn_at); return x < changeAt && x >= changeAt - 7 * DAY; });
        decisions.push(decideRollout({ name, stage, on: tally(after), off: tally(before), mode: "all_change" }));
      }
    }
    const downs = decisions.filter((d) => d.action === "down");
    if (mode === "on") {
      for (const d of downs) {
        await db.from("rollout_overrides").upsert({ switch_name: d.name, stage: d.to, reason: d.why, set_by: "rollout-watch", updated_at: new Date().toISOString() }, { onConflict: "switch_name" });
        await db.from("ops_anomalies").insert({ kind: "rollout_down", label: "スイッチを1段戻した", severity: "warn", value: d.dropPt, why: `${d.name}: ${d.from} → ${d.to}（${d.why}）`, detail: { switch: d.name, from: d.from, to: d.to } });
      }
    }
    console.log(JSON.stringify({ tag: "rollout-watch", mode, decisions }));
    return NextResponse.json({ ok: true, mode, decisions, wrote: mode === "on" ? downs.length : 0 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
