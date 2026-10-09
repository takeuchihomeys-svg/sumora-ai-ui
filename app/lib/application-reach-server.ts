// app/lib/application-reach-server.ts — 申込到達率（場面×段階×ブレインの判断）を台帳から数えて brain_action_reach_stats に置く／ブレインに渡す注記を読む（サーバー専用・LLM なし）
//   決まりは application-reach.ts（純関数）。⚠ 画面から import しない（supabase を読む）。
//   書くのは brain_action_reach_stats だけ（集計の置き場・毎日作り直す）。元の表（deal_outcomes・outcome_events）は読むだけ。
import { supabase } from "@/app/lib/supabase";
import { isTestConversation } from "@/app/lib/test-conversations";
import {
  computeReachStats, buildReachNote, reachMinN, REACH_WINDOW_DAYS, confirmedWinWeight, confirmedWinWeightEnabled,
  withConfirmedWinMark, isConfirmedWinNotes, CONFIRMED_WIN_IMPORTANCE, reachStrictEnabled,
  type ReachDecisionPoint, type ReachEpisode, type ReachStatRow, type StageBucket,
} from "@/app/lib/application-reach";

type Sb = typeof supabase;
const DAY = 86_400_000;

/** 台帳から数える（書かない）。判断の出来事（outcome_events kind=brain_decision）と案件（deal_outcomes） */
export async function computeReachStatsFromLedger(opts: { db?: Sb; nowMs?: number; strict?: boolean } = {}): Promise<{ rows: ReachStatRow[]; points: number; episodes: number; withScene: number }> {
  const db = opts.db ?? supabase;
  const nowMs = opts.nowMs ?? Date.now();
  const since = new Date(nowMs - REACH_WINDOW_DAYS * DAY).toISOString();
  const strict = opts.strict ?? reachStrictEnabled(process.env);
  const points: ReachDecisionPoint[] = [];
  let withScene = 0;
  for (let i = 0; i < 200_000; i += 1000) {
    const { data, error } = await db.from("outcome_events").select("conversation_id, episode_no, at, decision_id, detail").eq("kind", "brain_decision").gte("at", since).order("at").order("id").range(i, i + 999);
    if (error) throw new Error(`outcome_events: ${error.message}`);
    for (const r of (data ?? []) as Array<{ conversation_id: string; episode_no: number; at: string; decision_id: string | null; detail: { action?: string | null; scene?: string | null; vb?: StageBucket | null; src?: string | null } | null }>) {
      if (isTestConversation(r.conversation_id)) continue;
      if (r.detail?.scene) withScene++;
      points.push({ conversationId: r.conversation_id, episodeNo: r.episode_no, at: r.at, action: r.detail?.action ?? null, scene: r.detail?.scene ?? null, bucket: r.detail?.vb ?? null,
        src: r.detail?.src ?? null, decisionId: r.decision_id });
    }
    if ((data ?? []).length < 1000) break;
  }
  // 2026-10-08 改善案②: 実際に送った AIX（判断に結び付いた aix_sent の一番早い物）。結び付きは台帳（deal-outcome-server の decisionFor）が付けた decision_id
  if (strict) {
    const actual = new Map<string, { at: number; type: string }>();
    for (let i = 0; i < 200_000; i += 1000) {
      const { data, error } = await db.from("outcome_events").select("decision_id, at, detail").eq("kind", "aix_sent").not("decision_id", "is", null).gte("at", since).order("at").order("id").range(i, i + 999);
      if (error) throw new Error(`outcome_events(aix_sent): ${error.message}`);
      for (const r of (data ?? []) as Array<{ decision_id: string; at: string; detail: { aix_type?: string | null } | null }>) {
        const t = r.detail?.aix_type; if (!t) continue;
        const at = Date.parse(r.at); const prev = actual.get(r.decision_id);
        if (!prev || at < prev.at) actual.set(r.decision_id, { at, type: t });
      }
      if ((data ?? []).length < 1000) break;
    }
    for (const p of points) p.actualAction = p.decisionId ? actual.get(p.decisionId)?.type ?? null : null;
  }
  const convIds = [...new Set(points.map((p) => p.conversationId))];
  const episodes: ReachEpisode[] = [];
  for (let i = 0; i < convIds.length; i += 200) {
    const { data, error } = await db.from("deal_outcomes").select("conversation_id, episode_no, applied_at, result, result_certainty, switch_reason").in("conversation_id", convIds.slice(i, i + 200));
    if (error) throw new Error(`deal_outcomes: ${error.message}`);
    for (const r of (data ?? []) as Array<{ conversation_id: string; episode_no: number; applied_at: string | null; result: string | null; result_certainty: string | null; switch_reason: string | null }>) {
      // 2026-10-08 竹内さん: 確定の成約はより重い正解（推定の成約は数えない）
      episodes.push({ conversationId: r.conversation_id, episodeNo: r.episode_no, appliedAt: r.applied_at, result: r.result, confirmedWon: r.result === "won" && r.result_certainty === "confirmed", switchReason: r.switch_reason });
    }
  }
  return { rows: computeReachStats(points, episodes, { nowMs, strict }), points: points.length, episodes: episodes.length, withScene };
}

/** 数えて brain_action_reach_stats を作り直す（表が無い環境は書かずに返す） */
export async function refreshReachStats(opts: { db?: Sb; nowMs?: number } = {}): Promise<{ rows: number; points: number; overLine: number; written: boolean; error?: string }> {
  const db = opts.db ?? supabase;
  const nowMs = opts.nowMs ?? Date.now();
  const r = await computeReachStatsFromLedger({ db, nowMs });
  const computedAt = new Date(nowMs).toISOString();
  const minN = reachMinN(process.env);
  const overLine = r.rows.filter((x) => x.n >= minN).length;
  const { error: delErr } = await db.from("brain_action_reach_stats").delete().gte("n", 0);
  if (delErr) return { rows: r.rows.length, points: r.points, overLine, written: false, error: delErr.message };
  if (r.rows.length) {
    let { error } = await db.from("brain_action_reach_stats").insert(r.rows.map((x) => ({ ...x, computed_at: computedAt })));
    // 列 won（確定の成約・10/08）がまだ無い環境は won を外して入れる（migrate-schema の段を流すまで）
    if (error && /won/.test(error.message)) ({ error } = await db.from("brain_action_reach_stats").insert(r.rows.map(({ won: _w, ...x }) => { void _w; return { ...x, computed_at: computedAt }; })));
    if (error) return { rows: r.rows.length, points: r.points, overLine, written: false, error: error.message };
  }
  cache = null;
  return { rows: r.rows.length, points: r.points, overLine, written: true };
}

let cache: { at: number; rows: ReachStatRow[]; computedAt: string | null } | null = null;
const CACHE_MS = 10 * 60_000;

/** ブレインに渡す注記（場面と段階が合い、線を超えた判断が2つ以上の時だけ・無ければ ""）。表が無い・読めない時も "" */
export async function loadReachNote(scene: string | null | undefined, bucket: StageBucket | null | undefined, opts: { labels?: Record<string, string> } = {}): Promise<string> {
  if (!scene || !bucket) return "";
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      let res = await supabase.from("brain_action_reach_stats").select("scene_key, stage_bucket, action, n, reached, rate, won, computed_at").limit(2000);
      if (res.error) res = await supabase.from("brain_action_reach_stats").select("scene_key, stage_bucket, action, n, reached, rate, computed_at").limit(2000) as typeof res;
      const { data, error } = res;
      if (error) { cache = { at: Date.now(), rows: [], computedAt: null }; return ""; }
      const rows = ((data ?? []) as Array<ReachStatRow & { computed_at: string | null }>).map((r) => ({ ...r, n: Number(r.n), reached: Number(r.reached), rate: Number(r.rate), won: Number(r.won ?? 0) }));
      cache = { at: Date.now(), rows, computedAt: rows[0]?.computed_at ?? null };
    }
    return buildReachNote(cache.rows, scene, bucket, { minN: reachMinN(process.env), computedAt: cache.computedAt, labels: opts.labels, winWeight: confirmedWinWeight(process.env), strict: reachStrictEnabled(process.env) });
  } catch {
    return "";
  }
}

/**
 * 2026-10-08 竹内さん「さらにちゃんと成約したのはより良いデータとして入れておく」: 確定の成約（deal_outcomes result=won・result_certainty=confirmed）の
 *   会話の成約パターン（winning_patterns・source_conversation_id）に印 [成約確定] と重要度 10 を付ける（失注の行は触らない・何度呼んでも同じ）。
 *   ブレインは印のある行を【申込に届いた・成約確定】として先に読む（application-reach.orderWinningPatterns・winningOutcomeTag）。
 *   毎日の台帳（cron/outcome-ledger）の後と、30日の確認で「成約した」を選んだ時に呼ぶ。WIN_CONFIRMED_WEIGHT=off で何もしない
 */
export async function markConfirmedWinPatterns(opts: { db?: Sb; conversationIds?: string[] } = {}): Promise<{ conversations: number; marked: number; skipped?: string }> {
  if (!confirmedWinWeightEnabled(process.env)) return { conversations: 0, marked: 0, skipped: "off" };
  const db = opts.db ?? supabase;
  let q = db.from("deal_outcomes").select("conversation_id").eq("result", "won").eq("result_certainty", "confirmed");
  if (opts.conversationIds?.length) q = q.in("conversation_id", opts.conversationIds);
  const { data, error } = await q.limit(5000);
  if (error) return { conversations: 0, marked: 0, skipped: error.message };
  const ids = [...new Set(((data ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))].filter((id) => !isTestConversation(id));
  let marked = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const { data: wp, error: e2 } = await db.from("winning_patterns").select("id, notes, importance, outcome_type").in("source_conversation_id", ids.slice(i, i + 100));
    if (e2) return { conversations: ids.length, marked, skipped: e2.message };
    for (const r of (wp ?? []) as Array<{ id: string; notes: string | null; importance: number | null; outcome_type: string | null }>) {
      if (r.outcome_type === "closed_lost" || isConfirmedWinNotes(r.notes)) continue;
      const { error: e3 } = await db.from("winning_patterns").update({ notes: withConfirmedWinMark(r.notes), importance: Math.max(r.importance ?? 0, CONFIRMED_WIN_IMPORTANCE) }).eq("id", r.id);
      if (!e3) marked++;
    }
  }
  return { conversations: ids.length, marked };
}
