// app/lib/application-reach.ts — 「場面×ブレインの判断 → 申込まで届いた割合」（申込到達率）の決まり。純関数・DB 依存なし・LLM なし。
//
// 竹内さんの決定（2026-10-08）:
//   ① 「申込までで成約データとして扱って大丈夫。申込までのツールなので」→ このツールの成功＝申込に届いた事。
//      学習・実績・ブレインに渡す数字は「申込到達」で数える（成約は申込のツールの領分の参考）。
//   ⑥ ブレインに渡していた成約の勝ち率（aix_action_attribution）は止める（推定の成約込み・段階の偏り・1週間後の状態で数える＝成約データでも効果でもない）。
//      置き換え＝場面×ブレインの判断（AIX）→ 申込まで届いた割合。確定の申込・案件の段階で揃える・件数が線を超えた物だけ・2択の時だけ渡す。
//   設計知見 5e006794（勝率表の調査）・92efa58f（台帳の決まり）・a087aec0（オススメ→見積→申込の3連）。
//
// 数え方（決まり）:
//   - 単位は「案件（deal_outcomes の会話×案件）」。同じ案件で同じ場面・同じ段階・同じ判断が何度出ても1つ（最初の判断）。
//   - 申込に届いた＝その案件の applied_at（台帳の申込の時刻）が判断より後にある。申込の後の判断は数えない（申込以降は別ツールの領分）。
//   - 段階で揃える: 判断の時点でその会話の内覧が済んでいたか（内覧前／内覧後）で分ける。後ろの段階の判断ほど届きやすい偏り（5e006794 ②）を同じ段階の中の比べにする。
//   - 結果が分からない案件は数えない: まだ進行中で、判断から30日たっていない物（右側の打ち切り）。
//   - 2択の時だけ: 同じ場面・同じ段階で、線（既定20案件）を超えた判断が2つ以上ある時だけ渡す（比べられる時だけ・1つだけの数字は渡さない）。
//   - 言い回しの指示は書かない・材料だけ（「重視すること」は書かない）。相関であって因果ではないと添える。
import { resolveReplyScene, type ReplyScene } from "./reply-scene";

/** 新しい数え方（申込到達）をブレインに渡す。BRAIN_APPLY_REACH=off で止める */
export function applicationReachEnabled(env: Record<string, string | undefined>): boolean {
  return (env.BRAIN_APPLY_REACH ?? "").trim().toLowerCase() !== "off";
}
/** 旧の成約の勝ち率（aix_action_attribution）を読む所（brain-core・aix/suggest・auto-reply-readiness・morning-report・suggest-next-action）。既定は読まない。BRAIN_ACTION_WIN_RATES=on で旧 */
export function legacyActionWinRatesEnabled(env: Record<string, string | undefined>): boolean {
  return (env.BRAIN_ACTION_WIN_RATES ?? "").trim().toLowerCase() === "on";
}
/**
 * 「申込基準」で読む（決定①③）: 成約パターンの分析（analyze-closed）は申込に届いた事を正にし、申込の時刻までの会話で分析する／
 * 朝の日報は「昨日の申込」を出す。OUTCOME_APPLY_BASIS=off で旧（成約＝closed_won で読む）
 */
export function outcomeApplyBasisEnabled(env: Record<string, string | undefined>): boolean {
  return (env.OUTCOME_APPLY_BASIS ?? "").trim().toLowerCase() !== "off";
}
/** 線（1つの判断の案件数の下限）。BRAIN_APPLY_REACH_MIN_N で変えられる（5〜500） */
export const DEFAULT_REACH_MIN_N = 20;
export function reachMinN(env: Record<string, string | undefined>): number {
  const n = Number((env.BRAIN_APPLY_REACH_MIN_N ?? "").trim());
  return Number.isFinite(n) && n >= 5 && n <= 500 ? Math.floor(n) : DEFAULT_REACH_MIN_N;
}
/** 集計に使う判断の期間（日） */
export const REACH_WINDOW_DAYS = 180;
/** 進行中の案件の判断は、この日数たってから数える（右側の打ち切り） */
export const REACH_MATURE_DAYS = 30;

/** 判断の「返信（AIX なし）」のキー */
export const REPLY_ACTION_KEY = "reply";
export type StageBucket = "pre_viewing" | "post_viewing";
export const STAGE_BUCKET_LABEL: Record<StageBucket, string> = { pre_viewing: "内覧前", post_viewing: "内覧後" };

export const SCENE_LABEL: Record<string, string> = {
  ack: "お礼・了承", question: "質問", conditions: "条件", property_share: "物件の持ち込み", cost: "費用",
  apply: "申込", viewing: "内覧", considering: "検討中", other: "その他",
};

const DAY = 86_400_000;
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

/** 判断の action（brain_decision_logs.suggested_action）→ 数えるキー。空は返信（AIX なし） */
export function reachActionKey(action: string | null | undefined): string {
  const a = (action ?? "").trim();
  return a ? a : REPLY_ACTION_KEY;
}

/**
 * ブレインが読んだ番のお客様の文（返していないお客様の連投・画像/動画は除く）→ 場面（reply-scene）。
 *   brain-core の brainScene（unrepliedCustomerTurn(...).text → resolveReplyScene）と同じ形にそろえる。
 * @param oldestFirst 古い順のメッセージ
 * @param atMs 判断が読んだ最後のお客様の発言の時刻（analyzed_msg_ts・無ければ判断の時刻）
 */
export function turnSceneAt(oldestFirst: ReadonlyArray<{ sender: string; text: string | null; createdAt: string }>, atMs: number): ReplyScene | null {
  const upto = oldestFirst.filter((m) => { const t = ms(m.createdAt); return Number.isFinite(t) && t <= atMs + 1000; });
  if (!upto.length) return null;
  const block: string[] = [];
  for (let i = upto.length - 1; i >= 0; i--) {
    const m = upto[i];
    if (m.sender !== "customer") break;
    const t = (m.text ?? "").trim();
    if (!t || /^\[(?:画像|動画)\]/.test(t)) continue;
    block.push(t);
  }
  return resolveReplyScene({ customerText: block.reverse().join("\n") }).scene;
}

/** 判断の時点の段階（内覧前／内覧後）。内覧の日（予定の日・実施）がその時刻より前にあれば内覧後 */
export function stageBucketAt(viewingAts: ReadonlyArray<string>, atMs: number): StageBucket {
  return viewingAts.some((v) => { const t = ms(v); return Number.isFinite(t) && t <= atMs; }) ? "post_viewing" : "pre_viewing";
}

export type ReachDecisionPoint = {
  conversationId: string; episodeNo: number; at: string;
  action: string | null; scene: string | null; bucket: StageBucket | null;
};
export type ReachEpisode = { conversationId: string; episodeNo: number; appliedAt: string | null; result: string | null };
export type ReachStatRow = { scene_key: string; stage_bucket: StageBucket; action: string; n: number; reached: number; rate: number };

/** 判断と案件から、場面×段階×判断 → 申込到達率を数える（同じ案件の同じキーは最初の判断だけ） */
export function computeReachStats(points: ReadonlyArray<ReachDecisionPoint>, episodes: ReadonlyArray<ReachEpisode>, opts: { nowMs: number; windowDays?: number; matureDays?: number }): ReachStatRow[] {
  const epMap = new Map(episodes.map((e) => [`${e.conversationId}|${e.episodeNo}`, e]));
  const from = opts.nowMs - (opts.windowDays ?? REACH_WINDOW_DAYS) * DAY;
  const mature = (opts.matureDays ?? REACH_MATURE_DAYS) * DAY;
  const first = new Map<string, { at: number; reached: boolean }>();
  for (const p of points) {
    if (!p.scene || !p.bucket) continue;
    const at = ms(p.at);
    if (!Number.isFinite(at) || at < from) continue;
    const ep = epMap.get(`${p.conversationId}|${p.episodeNo}`);
    if (!ep) continue;
    const applied = ms(ep.appliedAt);
    if (Number.isFinite(applied) && applied <= at) continue; // 申込の後の判断は数えない
    const reached = Number.isFinite(applied) && applied > at;
    if (!reached && (ep.result ?? "in_progress") === "in_progress" && opts.nowMs - at < mature) continue; // まだ分からない
    const key = `${p.scene}|${p.bucket}|${reachActionKey(p.action)}|${p.conversationId}|${p.episodeNo}`;
    const prev = first.get(key);
    if (!prev || at < prev.at) first.set(key, { at, reached });
  }
  const agg = new Map<string, { n: number; reached: number }>();
  for (const [key, v] of first) {
    const [scene, bucket, action] = key.split("|");
    const k = `${scene}|${bucket}|${action}`;
    const a = agg.get(k) ?? { n: 0, reached: 0 };
    a.n++; if (v.reached) a.reached++;
    agg.set(k, a);
  }
  return [...agg.entries()].map(([k, a]) => {
    const [scene_key, stage_bucket, action] = k.split("|");
    return { scene_key, stage_bucket: stage_bucket as StageBucket, action, n: a.n, reached: a.reached, rate: a.n ? Math.round((a.reached / a.n) * 1000) / 1000 : 0 };
  }).sort((x, y) => x.scene_key.localeCompare(y.scene_key) || x.stage_bucket.localeCompare(y.stage_bucket) || y.n - x.n || x.action.localeCompare(y.action));
}

/**
 * ブレインに渡す1〜数行（場面と段階が合い、線を超えた判断が2つ以上ある時だけ・無ければ ""）。
 *   言い回しの指示は書かない（材料だけ）。いつの集計かを付ける。
 */
export function buildReachNote(rows: ReadonlyArray<ReachStatRow>, scene: string | null | undefined, bucket: StageBucket | null | undefined, opts: { minN: number; computedAt?: string | null; labels?: Record<string, string> }): string {
  if (!scene || !bucket) return "";
  const hit = rows.filter((r) => r.scene_key === scene && r.stage_bucket === bucket && r.n >= opts.minN)
    .sort((a, b) => b.rate - a.rate || b.n - a.n || a.action.localeCompare(b.action)).slice(0, 4);
  if (hit.length < 2) return "";
  const label = (a: string) => (a === REPLY_ACTION_KEY ? "返信（AIX なし）" : `AIX ${opts.labels?.[a] ? `${opts.labels[a]}（${a}）` : a}`);
  const when = opts.computedAt ? `・${new Date(ms(opts.computedAt) + 9 * 3600_000).toISOString().slice(5, 10).replace("-", "/")} 集計` : "";
  return [
    `【この場面の実績（申込まで届いた割合・場面「${SCENE_LABEL[scene] ?? scene}」・${STAGE_BUCKET_LABEL[bucket]}${when}）】`,
    ...hit.map((r) => `- ${label(r.action)}: ${Math.round(r.rate * 100)}%（${r.reached}/${r.n}案件）`),
    "※ 過去の案件の割合（相関で因果ではない）。どちらにするかは今の会話で決める",
  ].join("\n");
}

/** 申込に届いた案件か（学習・実績の数え方の正。成約の確かさは問わない） */
export function reachedApplication(r: { applied_at?: string | null; max_stage?: string | null }): boolean {
  return !!r.applied_at || r.max_stage === "applied" || r.max_stage === "screening" || r.max_stage === "won";
}

/**
 * 成約パターン（winning_patterns.outcome_type）の札。申込基準（既定）では applying・closed_won はどちらも「申込に届いた」（決定①③）。
 *   旧（OUTCOME_APPLY_BASIS=off）は失注以外を【成約】と呼んでいた（申込の時点の分析も【成約】になっていた）
 */
export function winningOutcomeTag(outcomeType: string | null | undefined, env: Record<string, string | undefined>): string {
  if (outcomeType === "closed_lost") return "【失注】";
  return outcomeApplyBasisEnabled(env) ? "【申込に届いた】" : "【成約】";
}

export type AnalyzeOutcome = "applying" | "closed_won" | "closed_lost";
/** 成約分析（analyze-closed）で使う結果: 申込基準なら closed_won も「申込」として分析する */
export function analysisOutcomeOf(outcome: AnalyzeOutcome, env: Record<string, string | undefined>): AnalyzeOutcome {
  return outcome === "closed_won" && outcomeApplyBasisEnabled(env) ? "applying" : outcome;
}
/**
 * 分析に渡す会話の終わり（申込の時刻）。一番新しい案件の申込の時刻。無ければ null（全部）。
 *   申込の後（申込中・審査中・契約）の文は「申込に届いた理由」ではない・申込の書類の文を分析に載せない
 */
export function analysisCutoffAt(rows: ReadonlyArray<{ episode_no: number; applied_at: string | null; result?: string | null }>): string | null {
  // 一番新しい案件だけを見る（前の案件の申込の時刻で切らない＝審査落ちの後の新しい申込を台帳の作り直しの前に分析する時に、前の申込で切ってしまう）
  const latest = [...rows].sort((a, b) => b.episode_no - a.episode_no)[0];
  // 切り替え・失注で終わった案件の申込は「今の申込」ではない（台帳の作り直しの前）→ 切らない
  if (!latest || latest.result === "switched" || latest.result === "lost") return null;
  return latest.applied_at && Number.isFinite(Date.parse(latest.applied_at)) ? latest.applied_at : null;
}
