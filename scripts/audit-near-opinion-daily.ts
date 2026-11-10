// scripts/audit-near-opinion-daily.ts — 入口の意見（CONDUCTOR_NEAR_OPINION・11/11 既定 on）の1週間の見張り（読むだけ・LLM なし・費用 0）
//
// 2026-11-11 作業員4（統括役の指示）: 毎朝、本番の見張りの番（line_watch_turns）と判断の記録（brain_decision_logs.digest.nop）を並べて数える。
//   ① 意見が出た番の割合（nop が「-」でない・timeout も別に数える）
//   ② 出た時、意見の一手（返信／AIX）がスタッフの最初の一手（staffFirstMove）と同じだった割合（竹内さんの番は別に）
//   ③ 出た時、ブレインの最初の答え（brain_reply_mode）がスタッフと同じだった割合（意見が無い番の当たりと比べる）
//   下がったら CONDUCTOR_NEAR_OPINION=off に戻す案の線: ② が 70% 未満（3日続けて・1日 5番以上）か、③ が意見の無い番より 10点以上低い
//   営業時間（JST 9〜22時）は動かない（--force で手元の確かめだけ）。窓 --hours（既定 24・最大 168）
// 実行: npx tsx --env-file=<鍵のある env> scripts/audit-near-opinion-daily.ts [--hours=24]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { staffFirstMove, aixLogsFromWatch, staffMoveExclusion, ackSceneOf } from "../app/lib/staff-first-move";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date()));
if (jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force")) { console.log(`営業時間（JST ${jstHour}時）は回さない（22時以降に）`); process.exit(0); }
const HOURS = Math.min(168, Math.max(1, Number(arg("hours", "24"))));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");

/** digest.nop（"返信/promise_make:30:0.93|30" / "-|12" / "timeout"）から意見の一手（無ければ null） */
export function opinionMoveOf(nop: string | null | undefined): "AIX" | "返信" | null {
  const s = String(nop ?? "");
  if (!s || s === "timeout" || s.startsWith("-")) return null;
  return s.startsWith("AIX") ? "AIX" : s.startsWith("返信") ? "返信" : null;
}

type W = { id: number; conversation_id: string; customer_turn_at: string; decision_id: string | null; brain_reply_mode: string | null; scene_key: string | null; staff_aix: Array<{ at?: string; aix_type?: string; check_pattern?: string | null }> | null };

(async () => {
  const since = new Date(Date.now() - HOURS * 3_600_000).toISOString();
  const turns: W[] = [];
  for (let p = 0; ; p += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, decision_id, brain_reply_mode, scene_key, staff_aix").gte("customer_turn_at", since).order("customer_turn_at").range(p, p + 999);
    if (error) throw new Error(error.message);
    turns.push(...((data ?? []) as W[]));
    if ((data ?? []).length < 1000) break;
  }
  const ws = turns.filter((w) => !isTestConversation(w.conversation_id));
  const dg = new Map<string, Record<string, unknown>>();
  const ids = [...new Set(ws.map((w) => w.decision_id).filter((x): x is string => !!x))];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("brain_decision_logs").select("id, digest").in("id", ids.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ id: string; digest: Record<string, unknown> | null }>) dg.set(r.id, r.digest ?? {});
  }
  const convs = [...new Set(ws.map((w) => w.conversation_id))];
  const staffMsgs = new Map<string, Array<{ at: number; isAix: boolean; writer: string | null }>>();
  for (let i = 0; i < convs.length; i += 100) {
    for (let p = 0; ; p += 1000) {
      const { data, error } = await sb.from("messages").select("conversation_id, created_at, staff_writer, is_aix_generated").in("conversation_id", convs.slice(i, i + 100)).neq("sender", "customer").gte("created_at", since).order("created_at").range(p, p + 999);
      if (error) throw new Error(error.message);
      for (const m of (data ?? []) as Array<{ conversation_id: string; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null }>) { const a = staffMsgs.get(m.conversation_id) ?? []; a.push({ at: Date.parse(m.created_at), isAix: !!m.is_aix_generated, writer: m.staff_writer }); staffMsgs.set(m.conversation_id, a); }
      if ((data ?? []).length < 1000) break;
    }
  }
  const c = { n: 0, recorded: 0, fired: 0, timeout: 0, opHit: 0, brainHitFired: 0, noOpN: 0, brainHitNoOp: 0, tkFired: 0, tkOpHit: 0 };
  const miss: string[] = [];
  for (const w of ws) {
    const t = Date.parse(w.customer_turn_at);
    const fm = staffFirstMove(t, staffMsgs.get(w.conversation_id) ?? [], aixLogsFromWatch(w.staff_aix));
    if (!fm || staffMoveExclusion(t, fm, { ackOnly: ackSceneOf(w.scene_key) })) continue;
    c.n++;
    const nop = w.decision_id ? (dg.get(w.decision_id)?.nop as string | undefined) : undefined;
    if (nop) c.recorded++;
    if (nop === "timeout") c.timeout++;
    const staff = fm.kind === "aix" ? "AIX" : "返信";
    const brain = w.brain_reply_mode === "aix" ? "AIX" : w.brain_reply_mode ? "返信" : null;
    const op = opinionMoveOf(nop);
    if (op) {
      c.fired++; if (op === staff) c.opHit++; else if (miss.length < 10) miss.push(`  番 ${w.id}（${w.scene_key ?? "場面なし"}）: 意見 ${nop} ／ スタッフ ${fm.kind === "aix" ? `AIX:${fm.aix}` : "返信"}`);
      if (brain === staff) c.brainHitFired++;
      if (fm.writer === "takeuchi") { c.tkFired++; if (op === staff) c.tkOpHit++; }
    } else if (brain) { c.noOpN++; if (brain === staff) c.brainHitNoOp++; }
  }
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
  console.log(`入口の意見の見張り（直近 ${HOURS} 時間・テスト会話を除く・数えた番 ${c.n}）`);
  console.log(`  記録あり ${c.recorded}・意見が出た ${c.fired}（${pct(c.fired, c.n)}）・時間切れ/読めない ${c.timeout}`);
  console.log(`  出た時、意見がスタッフの最初の一手と同じ: ${c.opHit}/${c.fired}（${pct(c.opHit, c.fired)}）・うち竹内さん ${c.tkOpHit}/${c.tkFired}（${pct(c.tkOpHit, c.tkFired)}）`);
  console.log(`  ブレインがスタッフと同じ: 意見あり ${c.brainHitFired}/${c.fired}（${pct(c.brainHitFired, c.fired)}）・意見なし ${c.brainHitNoOp}/${c.noOpN}（${pct(c.brainHitNoOp, c.noOpN)}）`);
  if (miss.length) console.log(`  意見の外れ（最大10）:\n${miss.join("\n")}`);
  const bad = c.fired >= 5 && (c.opHit / c.fired < 0.7 || (c.noOpN >= 10 && c.brainHitFired / c.fired + 0.1 < c.brainHitNoOp / c.noOpN));
  console.log(bad ? "  ⚠ 線を下回った（3日続けば CONDUCTOR_NEAR_OPINION=off を統括役に）" : "  線の内（意見の当たり 70% 以上・意見ありの番のブレインの当たりが意見なしより10点以上低くない）");
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
