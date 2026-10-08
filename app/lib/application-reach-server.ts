// app/lib/application-reach-server.ts — 申込到達率（場面×段階×ブレインの判断）を台帳から数えて brain_action_reach_stats に置く／ブレインに渡す注記を読む（サーバー専用・LLM なし）
//   決まりは application-reach.ts（純関数）。⚠ 画面から import しない（supabase を読む）。
//   書くのは brain_action_reach_stats だけ（集計の置き場・毎日作り直す）。元の表（deal_outcomes・outcome_events）は読むだけ。
import { supabase } from "@/app/lib/supabase";
import { isTestConversation } from "@/app/lib/test-conversations";
import {
  computeReachStats, buildReachNote, reachMinN, REACH_WINDOW_DAYS,
  type ReachDecisionPoint, type ReachEpisode, type ReachStatRow, type StageBucket,
} from "@/app/lib/application-reach";

type Sb = typeof supabase;
const DAY = 86_400_000;

/** 台帳から数える（書かない）。判断の出来事（outcome_events kind=brain_decision）と案件（deal_outcomes） */
export async function computeReachStatsFromLedger(opts: { db?: Sb; nowMs?: number } = {}): Promise<{ rows: ReachStatRow[]; points: number; episodes: number; withScene: number }> {
  const db = opts.db ?? supabase;
  const nowMs = opts.nowMs ?? Date.now();
  const since = new Date(nowMs - REACH_WINDOW_DAYS * DAY).toISOString();
  const points: ReachDecisionPoint[] = [];
  let withScene = 0;
  for (let i = 0; i < 200_000; i += 1000) {
    const { data, error } = await db.from("outcome_events").select("conversation_id, episode_no, at, detail").eq("kind", "brain_decision").gte("at", since).order("at").order("id").range(i, i + 999);
    if (error) throw new Error(`outcome_events: ${error.message}`);
    for (const r of (data ?? []) as Array<{ conversation_id: string; episode_no: number; at: string; detail: { action?: string | null; scene?: string | null; vb?: StageBucket | null } | null }>) {
      if (isTestConversation(r.conversation_id)) continue;
      if (r.detail?.scene) withScene++;
      points.push({ conversationId: r.conversation_id, episodeNo: r.episode_no, at: r.at, action: r.detail?.action ?? null, scene: r.detail?.scene ?? null, bucket: r.detail?.vb ?? null });
    }
    if ((data ?? []).length < 1000) break;
  }
  const convIds = [...new Set(points.map((p) => p.conversationId))];
  const episodes: ReachEpisode[] = [];
  for (let i = 0; i < convIds.length; i += 200) {
    const { data, error } = await db.from("deal_outcomes").select("conversation_id, episode_no, applied_at, result").in("conversation_id", convIds.slice(i, i + 200));
    if (error) throw new Error(`deal_outcomes: ${error.message}`);
    for (const r of (data ?? []) as Array<{ conversation_id: string; episode_no: number; applied_at: string | null; result: string | null }>) {
      episodes.push({ conversationId: r.conversation_id, episodeNo: r.episode_no, appliedAt: r.applied_at, result: r.result });
    }
  }
  return { rows: computeReachStats(points, episodes, { nowMs }), points: points.length, episodes: episodes.length, withScene };
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
    const { error } = await db.from("brain_action_reach_stats").insert(r.rows.map((x) => ({ ...x, computed_at: computedAt })));
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
      const { data, error } = await supabase.from("brain_action_reach_stats").select("scene_key, stage_bucket, action, n, reached, rate, computed_at").limit(2000);
      if (error) { cache = { at: Date.now(), rows: [], computedAt: null }; return ""; }
      const rows = ((data ?? []) as Array<ReachStatRow & { computed_at: string | null }>).map((r) => ({ ...r, n: Number(r.n), reached: Number(r.reached), rate: Number(r.rate) }));
      cache = { at: Date.now(), rows, computedAt: rows[0]?.computed_at ?? null };
    }
    return buildReachNote(cache.rows, scene, bucket, { minN: reachMinN(process.env), computedAt: cache.computedAt, labels: opts.labels });
  } catch {
    return "";
  }
}
