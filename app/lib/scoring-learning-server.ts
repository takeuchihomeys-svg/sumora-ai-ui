// app/lib/scoring-learning-server.ts（サーバー専用・画面から import しない）
// 物件の点の重みの週1回の学習（読む・測る・提案・確かめ・版の保存）と、重みの版の読み込み・切り替え・戻し。
//
// 2026-09-25 竹内「自動的に学習されていく仕組みを作る。判定基準をより精度高くしていくために」
//   ・毎週1回（/api/cron/scoring-learning）・決定論・LLM を呼ばない（費用0）
//   ・最初は提案だけ（scoring_weights に status='proposed' で残す）。自動で入れるのは SCORING_LEARNING_AUTO_APPLY=on かつ
//     件数・確かめ用・続けて良くなった週の条件（scoring-learning.ts の AUTO_APPLY_RULES）を満たした時だけ
//   ・入れた重みは property-brain.ts の setReasonPointOverrides で judgeProperty に入る（applyActiveScoringWeights）。
//     版が読めない時・版が無い時は今の定数のまま
//   ・YUMA（竹内さんのテスト会話）は学びに入れない
import type { SupabaseClient } from "@supabase/supabase-js";
import { baseReasonPoints, setReasonPointOverrides, type SentRowLike, type PatternRowLike } from "./property-brain";
import {
  LEARNING_CONFIG, usableEpisodes, rankMetrics, codeStats, featureStats, segmentFeatureStats, splitHoldout, proposeWeights,
  evaluateProposal, decideAutoApply, isAdCode, sanitizeWeights, switchVersion, previousVersion,
  type Episode, type WeightMap, type WeightVersion, type RankMetrics,
} from "./scoring-learning";
import { adTwoMonthCodes, buildContext, customerAt, episodeFromSnapshot, episodeFromPool, episodeFromPickups, segmentsOf, isCustomerSend, POOL_SENT_WINDOW_MS, type ConditionHistoryRow } from "./scoring-learning-episodes";

type Row = Record<string, any>;
const D = 24 * 3600_000;
export const YUMA_CONVERSATION_ID = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

const CUST_COLS = "id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes";

async function all(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 1000, maxPages = 60): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < maxPages; p++) {
    const { data, error } = await build(p * page, p * page + page - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < page) break;
  }
  return out;
}
function chunks<T>(xs: T[], n: number): T[][] { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; }
function groupBy<T extends Row>(xs: T[], key: string): Map<string, T[]> { const m = new Map<string, T[]>(); for (const x of xs) { const k = x[key]; if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); } return m; }

// ─── 材料を読む ──────────────────────────────────────────────────────────────

export type EpisodeLoad = { episodes: Episode[]; counts: Record<string, number> };

/** 期間の「スタッフが選んだ回」を3つの材料から組み立てる（読むだけ） */
export async function loadEpisodes(sb: SupabaseClient, opts: { until: string; days: number; sources?: string[] }): Promise<EpisodeLoad> {
  const until = new Date(opts.until).getTime();
  const sinceIso = new Date(until - opts.days * D).toISOString();
  const untilIso = new Date(until).toISOString();
  const want = new Set(opts.sources ?? ["snapshot", "pool", "pickup"]);
  const counts: Record<string, number> = {};

  const snaps = want.has("snapshot")
    ? await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, sent_at, star_in_candidates, candidate_count, candidates")
      .gte("sent_at", sinceIso).lt("sent_at", untilIso).gte("candidate_count", 2).order("id").range(a, b) as never, 300)
    : [];
  const snapRows = snaps.filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID && s.property_customer_id);
  counts.snapshot_rows = snaps.length;

  const pools = want.has("pool")
    ? await all((a, b) => sb.from("property_candidate_pools").select("id, property_customer_id, site, candidates, sent_at")
      .gte("sent_at", sinceIso).lt("sent_at", untilIso).order("sent_at").range(a, b) as never, 300)
    : [];
  counts.pool_rows = pools.length;

  const pickups = want.has("pickup")
    ? await all((a, b) => sb.from("property_pickups").select("batch_id, property_customer_id, conversation_id, rank, property_name, room_no, status, sent_at, created_at, reason_codes")
      .gte("created_at", sinceIso).lt("created_at", untilIso).order("id").range(a, b) as never)
    : [];
  counts.pickup_rows = pickups.length;

  // YUMA の物件顧客（会話から）を外す
  const yumaCust = new Set<string>();
  {
    const { data } = await sb.from("conversations").select("property_customer_id").eq("id", YUMA_CONVERSATION_ID).maybeSingle();
    if (data?.property_customer_id) yumaCust.add(String(data.property_customer_id));
  }

  const custIds = [...new Set([...snapRows, ...pools, ...pickups].map((r) => r.property_customer_id as string).filter((x) => x && !yumaCust.has(x)))];
  const custs = new Map<string, Row>();
  const hist: Row[] = [], sents: Row[] = [], pats: Row[] = [];
  const sentSince = new Date(until - (opts.days + 200) * D).toISOString();
  const sentUntil = new Date(until + POOL_SENT_WINDOW_MS).toISOString();
  for (const c of chunks(custIds, 80)) {
    const { data, error } = await sb.from("property_customers").select(CUST_COLS).in("id", c);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Row[]) custs.set(r.id, r);
    hist.push(...await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").in("property_customer_id", c).range(a, b) as never));
    sents.push(...await all((a, b) => sb.from("sent_properties").select("property_customer_id, property_name, room_no, rent, delivery, source, sent_at").in("property_customer_id", c).gte("sent_at", sentSince).lt("sent_at", sentUntil).range(a, b) as never));
    pats.push(...await all((a, b) => sb.from("property_selection_patterns").select("property_customer_id, selling_points, selection_label, created_at").in("property_customer_id", c).lt("created_at", untilIso).range(a, b) as never));
  }
  const histOf = groupBy(hist, "property_customer_id"), sentOf = groupBy(sents, "property_customer_id"), patOf = groupBy(pats, "property_customer_id");

  const ctxAt = (pc: string, at: string, sentBeforeMs: number) => {
    const base = custs.get(pc);
    if (!base) return null;
    const { c } = customerAt(base, (histOf.get(pc) ?? []) as ConditionHistoryRow[], at);
    const before = (sentOf.get(pc) ?? []).filter((s) => Date.parse(s.sent_at) < sentBeforeMs && isCustomerSend(s)) as SentRowLike[];
    const pt = (patOf.get(pc) ?? []).filter((p) => Date.parse(p.created_at) < Date.parse(at)) as PatternRowLike[];
    return buildContext(c, before, pt, at);
  };

  const episodes: Episode[] = [];
  for (const s of snapRows) {
    const pc = String(s.property_customer_id);
    if (yumaCust.has(pc)) continue;
    const cands = (typeof s.candidates === "string" ? JSON.parse(s.candidates) : s.candidates) as Row[];
    const firstSent = Math.min(...(cands ?? []).map((c) => Date.parse(String(c.sent_at ?? ""))).filter(Number.isFinite), Date.parse(s.sent_at));
    const ctx = ctxAt(pc, s.sent_at, firstSent - 60_000);
    if (!ctx) continue;
    try { const e = episodeFromSnapshot(s, ctx); if (e) episodes.push(e); } catch { counts.snapshot_errors = (counts.snapshot_errors ?? 0) + 1; }
  }
  for (const p of pools) {
    const pc = String(p.property_customer_id ?? "");
    if (!pc || yumaCust.has(pc)) continue;
    const t = Date.parse(p.sent_at);
    const ctx = ctxAt(pc, p.sent_at, t - 10 * 60_000);
    if (!ctx) continue;
    try { const e = episodeFromPool(p, sentOf.get(pc) ?? [], ctx); if (e) episodes.push(e); } catch { counts.pool_errors = (counts.pool_errors ?? 0) + 1; }
  }
  for (const [, rows] of groupBy(pickups.filter((r) => r.conversation_id !== YUMA_CONVERSATION_ID && !yumaCust.has(String(r.property_customer_id ?? ""))), "batch_id")) {
    const pc = String(rows[0].property_customer_id ?? "");
    const ctx = pc ? ctxAt(pc, String(rows[0].created_at), Date.parse(String(rows[0].created_at))) : null;
    const e = episodeFromPickups(rows, ctx ? segmentsOf(ctx.profile, ctx.customer) : []);
    if (e) episodes.push(e);
  }
  for (const src of ["snapshot", "pool", "pickup"]) counts[`episodes_${src}`] = episodes.filter((e) => e.source === src).length;
  return { episodes, counts };
}

// ─── 版 ──────────────────────────────────────────────────────────────────────

export async function listWeightVersions(sb: SupabaseClient): Promise<WeightVersion[]> {
  const { data, error } = await sb.from("scoring_weights").select("version, status, weights, created_at").order("version");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Row[]).map((r) => ({ version: r.version, status: r.status, weights: sanitizeWeights(r.weights) ?? {}, created_at: r.created_at }));
}

/** 版を切り替える（0＝コードの既定に戻す）。DB の状態を switchVersion と同じにする */
export async function activateWeightVersion(sb: SupabaseClient, target: number, note?: string): Promise<{ ok: boolean; active: number; error?: string }> {
  try {
    const versions = await listWeightVersions(sb);
    const next = switchVersion(versions, target);
    const now = new Date().toISOString();
    for (const v of next) {
      const prev = versions.find((x) => x.version === v.version)!;
      if (prev.status === v.status) continue;
      const patch: Row = { status: v.status };
      if (v.status === "active") { patch.activated_at = now; if (note) patch.note = note; }
      if (v.status === "retired") patch.retired_at = now;
      // 先に retired にしてから active（active は1つだけの一意の索引）
      if (v.status === "retired") { const { error } = await sb.from("scoring_weights").update(patch).eq("version", v.version); if (error) throw new Error(error.message); }
    }
    for (const v of next) {
      if (v.status !== "active" || versions.find((x) => x.version === v.version)!.status === "active") continue;
      const { error } = await sb.from("scoring_weights").update({ status: "active", activated_at: now, ...(note ? { note } : {}) }).eq("version", v.version);
      if (error) throw new Error(error.message);
    }
    cache = null;
    return { ok: true, active: target };
  } catch (e) {
    return { ok: false, active: -1, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 前の版に戻す（今の active より前の一番新しい retired・無ければコードの既定） */
export async function rollbackWeightVersion(sb: SupabaseClient): Promise<{ ok: boolean; active: number; error?: string }> {
  const versions = await listWeightVersions(sb);
  return activateWeightVersion(sb, previousVersion(versions), "rollback");
}

// ─── 判定に入れる（judgeProperty を呼ぶ前に await する） ─────────────────────

let cache: { at: number; weights: WeightMap | null; version: number } | null = null;
const CACHE_MS = 10 * 60_000;

/**
 * active の重みを読んで property-brain に入れる（10分は読み直さない）。読めない・版が無い時は null（今の定数のまま）。
 *   判定の呼び出し元（/api/property-brain/judge・property-pickups-server の recordPickupBatch）で judgeProperty の前に1行呼ぶ。
 */
export async function applyActiveScoringWeights(sb: SupabaseClient): Promise<{ version: number; weights: WeightMap | null }> {
  if (cache && Date.now() - cache.at < CACHE_MS) { setReasonPointOverrides(cache.weights); return { version: cache.version, weights: cache.weights }; }
  let weights: WeightMap | null = null, version = 0;
  try {
    const { data, error } = await sb.from("scoring_weights").select("version, weights").eq("status", "active").order("version", { ascending: false }).limit(1).maybeSingle();
    if (!error && data) { weights = sanitizeWeights((data as Row).weights); version = weights ? Number((data as Row).version) : 0; }
    // 2026-09-25 反証レビュー: 版が手で書かれても AD の札は定数より弱めない（竹内「AD は2ヶ月以上高く・約1.3倍」）。
    //   加点の AD（段）は定数未満を捨て、減点の AD（AD なし・利益が出ない）は定数より 0 に近い値を捨てる
    if (weights) {
      for (const k of Object.keys(weights)) {
        if (!isAdCode(k)) continue;
        const b = baseReasonPoints(k);
        if ((b > 0 && weights[k] < b) || (b < 0 && weights[k] > b)) delete weights[k];
      }
      if (!Object.keys(weights).length) { weights = null; version = 0; }
    }
  } catch { weights = null; }
  cache = { at: Date.now(), weights, version };
  setReasonPointOverrides(weights);
  return { version, weights };
}

// ─── 週1回 ───────────────────────────────────────────────────────────────────

export type LearningReport = {
  ok: boolean;
  dry: boolean;
  until: string;
  days: number;
  counts: Record<string, number>;
  activeVersion: number;
  metrics: { all: RankMetrics; bySource: Record<string, RankMetrics>; train: RankMetrics; holdout: RankMetrics; adNeutralAll: RankMetrics; adNeutralHoldout: RankMetrics };
  features: ReturnType<typeof featureStats>;
  segments: ReturnType<typeof segmentFeatureStats>;
  codes: ReturnType<typeof codeStats>;
  proposal: ReturnType<typeof proposeWeights>;
  evaluation: ReturnType<typeof evaluateProposal>;
  autoApply: { apply: boolean; reason: string };
  runId?: number | null;
  proposedVersion?: number | null;
  error?: string;
};

export async function runScoringLearning(sb: SupabaseClient, opts: { until?: string; days?: number; dry?: boolean; autoApplyEnabled?: boolean } = {}): Promise<LearningReport> {
  const until = opts.until ?? new Date().toISOString();
  const days = opts.days ?? 180;
  const dry = !!opts.dry;
  const { episodes, counts } = await loadEpisodes(sb, { until, days });

  // 今の重み（active の版・無ければ既定）
  let versions: WeightVersion[] = [];
  try { versions = await listWeightVersions(sb); } catch { versions = []; }
  const act = versions.find((v) => v.status === "active") ?? null;
  const current = act?.weights ?? null;

  const usable = usableEpisodes(episodes);
  const { train, holdout } = splitHoldout(usable, LEARNING_CONFIG.holdoutFrac);
  const bySource: Record<string, RankMetrics> = {};
  for (const s of [...new Set(usable.map((e) => e.source))]) bySource[s] = rankMetrics(usable.filter((e) => e.source === s), baseReasonPoints, current);
  // 参考（提案ではない）: AD の札を全部 0 にした時の当たり方。AD は学習で弱めない方針なので、差は竹内さんの判断の材料として残すだけ
  const adCodes = [...new Set(usable.flatMap((e) => e.cands.flatMap((c) => c.codes)).filter((c) => isAdCode(c)))];
  const adNeutral: WeightMap = { ...(current ?? {}), ...Object.fromEntries(adCodes.map((c) => [c, 0])) };
  const proposal = proposeWeights(train, baseReasonPoints, current, LEARNING_CONFIG, adTwoMonthCodes());
  const evaluation = evaluateProposal(holdout, baseReasonPoints, current, proposal.weights);

  // 続けて良くなった週（直前の run から）
  let prevAccepted = 0;
  try {
    const { data } = await sb.from("scoring_learning_runs").select("improved").eq("dry", false).order("id", { ascending: false }).limit(8);
    for (const r of (data ?? []) as Row[]) { if (r.improved) prevAccepted++; else break; }
  } catch { prevAccepted = 0; }
  const enabled = opts.autoApplyEnabled ?? process.env.SCORING_LEARNING_AUTO_APPLY === "on";
  const autoApply = decideAutoApply({ enabled, improved: evaluation.improved, episodesTotal: usable.length, holdout: holdout.length, prevAccepted, changes: proposal.changes.length });

  const report: LearningReport = {
    ok: true, dry, until, days, counts: { ...counts, usable: usable.length, train: train.length, holdout: holdout.length }, activeVersion: act?.version ?? 0,
    metrics: { all: rankMetrics(usable, baseReasonPoints, current), bySource, train: rankMetrics(train, baseReasonPoints, current), holdout: evaluation.base, adNeutralAll: rankMetrics(usable, baseReasonPoints, adNeutral), adNeutralHoldout: rankMetrics(holdout, baseReasonPoints, adNeutral) },
    features: featureStats(usable), segments: segmentFeatureStats(usable), codes: codeStats(usable), proposal, evaluation, autoApply,
  };
  if (dry) return report;

  // 版（当たりが良くなった提案だけ版にする）
  let proposedVersion: number | null = null;
  if (evaluation.improved && proposal.changes.length) {
    const nextVersion = (versions.reduce((m, v) => Math.max(m, v.version), 0) || 0) + 1;
    const { error } = await sb.from("scoring_weights").insert({
      version: nextVersion, status: "proposed", weights: proposal.weights, base_version: act?.version ?? 0, source: "learning",
      note: proposal.changes.map((c) => `${c.code} ${c.from}→${c.to}`).join(" / "),
    });
    if (error) return { ...report, ok: false, error: `scoring_weights: ${error.message}` };
    proposedVersion = nextVersion;
  }
  const { data: run, error: runErr } = await sb.from("scoring_learning_runs").insert({
    dry: false, data_until: until, days, episodes_total: usable.length, train_n: train.length, holdout_n: holdout.length,
    counts: report.counts, active_version: act?.version ?? 0, metrics: report.metrics, feature_stats: report.features, segment_stats: report.segments,
    code_stats: report.codes, proposal: { changes: proposal.changes, skipped: proposal.skipped.slice(0, 80) }, holdout_base: evaluation.base, holdout_proposed: evaluation.proposed,
    improved: evaluation.improved, decision: evaluation.reason, proposed_version: proposedVersion, auto_applied: false, auto_reason: autoApply.reason,
  }).select("id").single();
  if (runErr) return { ...report, ok: false, error: `scoring_learning_runs: ${runErr.message}`, proposedVersion };
  const runId = Number((run as Row).id);
  if (proposedVersion != null) await sb.from("scoring_weights").update({ run_id: runId }).eq("version", proposedVersion);
  if (autoApply.apply && proposedVersion != null) {
    const r = await activateWeightVersion(sb, proposedVersion, `auto run ${runId}`);
    await sb.from("scoring_learning_runs").update({ auto_applied: r.ok, auto_reason: r.ok ? autoApply.reason : `切り替え失敗: ${r.error}` }).eq("id", runId);
  }
  return { ...report, runId, proposedVersion };
}
