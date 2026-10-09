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
//   - 2択の時だけ: 同じ場面・同じ段階で、線（既定10案件・10/08 に20から下げた）を超えた判断が2つ以上ある時だけ渡す（比べられる時だけ・1つだけの数字は渡さない）。
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
// 2026-10-08 竹内さん: 既定 20 → 10 案件（今は線を超える判断がほぼ無く、ブレインに何も渡らないため）。BRAIN_APPLY_REACH_MIN_N=20 で旧
export const DEFAULT_REACH_MIN_N = 10;
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
  /** 判断の出所（brain_decision_logs.decision_source・例 llm／guard:first_contact）。厳密な数え方で初回のガードを外すのに使う */
  src?: string | null;
  /** 実際に送った AIX（この判断に結び付いた aix_sent の一番早い aix_type・無ければ null＝返信）。厳密な数え方ではこちらで数える */
  actualAction?: string | null;
  /** 判断の id（outcome_events.decision_id）。実際に送った AIX を結び付けるのに使う */
  decisionId?: string | null;
};
/** confirmedWon: 確定の成約（スタッフ／申込のツールが成約にした・30日の確認で「成約した」＝deal_outcomes result=won・result_certainty=confirmed）。推定の成約は false */
export type ReachEpisode = { conversationId: string; episodeNo: number; appliedAt: string | null; result: string | null; confirmedWon?: boolean; switchReason?: string | null };
/** won: 申込に届いた案件のうち確定の成約まで行った数（より重い正解・2026-10-08 竹内さん） */
export type ReachStatRow = { scene_key: string; stage_bucket: StageBucket; action: string; n: number; reached: number; rate: number; won?: number };

// ─────────────────────────────────────────────────────────────────────────────
// 確定の成約＝より重い正解（2026-10-08 竹内さん「申込で良いけど、さらにちゃんと成約したのはより良いデータとして入れておく」）
//   成功の基準は申込到達のまま。確定の成約（スタッフ／申込のツールが成約にした・30日の確認で「成約した」）は、
//   申込到達率の並べ方・ブレインに渡す数字・成約パターン（winning_patterns）・オススメの学習の強い正・朝の日報で重く扱う。
//   推定の成約（自動の成約 20日・auto_seiyaku）は今まで通り使わない（countsAsConfirmedWin が false）。戻す: WIN_CONFIRMED_WEIGHT=off
// ─────────────────────────────────────────────────────────────────────────────
/** 確定の成約を重く扱うか（既定 on）。WIN_CONFIRMED_WEIGHT=off で旧（申込に届いた事だけ） */
export function confirmedWinWeightEnabled(env: Record<string, string | undefined>): boolean {
  return (env.WIN_CONFIRMED_WEIGHT ?? "").trim().toLowerCase() !== "off";
}
/** 確定の成約1件を申込到達の何件分に足すか（既定 1＝確定の成約は申込到達の2件分）。WIN_CONFIRMED_WEIGHT に数（0より大きく5まで）を入れると変えられる */
export function confirmedWinWeight(env: Record<string, string | undefined>): number {
  if (!confirmedWinWeightEnabled(env)) return 0;
  const n = Number((env.WIN_CONFIRMED_WEIGHT ?? "").trim());
  return Number.isFinite(n) && n > 0 && n <= 5 ? n : 1;
}
/** 並べ方の点（申込到達＋確定の成約×重み）／案件数。率そのもの（rate）は申込到達のまま */
export function reachScore(r: Pick<ReachStatRow, "n" | "reached" | "won">, weight: number): number {
  return r.n ? (r.reached + weight * (r.won ?? 0)) / r.n : 0;
}
/** 成約パターン（winning_patterns.notes）の確定の成約の印。毎日の台帳の後に付ける（application-reach-server.markConfirmedWinPatterns） */
export const CONFIRMED_WIN_MARK = "[成約確定]";
export function isConfirmedWinNotes(notes: string | null | undefined): boolean {
  return (notes ?? "").includes(CONFIRMED_WIN_MARK);
}
/** notes の先頭に印を付ける（付いていればそのまま） */
export function withConfirmedWinMark(notes: string | null | undefined): string {
  const n = (notes ?? "").trim();
  if (n.includes(CONFIRMED_WIN_MARK)) return n;
  return n ? `${CONFIRMED_WIN_MARK} / ${n}` : CONFIRMED_WIN_MARK;
}
/** 確定の成約の成約パターンの重要度（申込は 9・失注は 8） */
export const CONFIRMED_WIN_IMPORTANCE = 10;
// ─────────────────────────────────────────────────────────────────────────────
// 申込到達率の厳密な数え方（2026-10-08 竹内さん「進めて良い」＝調査の改善案1〜6）
//   調査（10/08）で、旧の数え方は率が1.5〜3倍に上に偏っていた（届いた判断はすぐ数え・届かない判断は30日待つ片側の打ち切り等）。
//   ① 固定の30日の窓: 判断から30日たった物だけ数え、「届いた」＝判断の後30日以内に申込（届いた物も届かない物も同じ線）
//   ② 実際に送った AIX で数える（ブレインの提案ではなく・その判断に結び付いた aix_sent。無ければ返信）
//   ③ 同じ案件は場面×段階ごとに最初の判断だけ（同じ案件が比べる2つの判断の両方に入らない）
//   ④ 確定の審査落ち（switched・screening_rejected）は申込に届いた物として数え、理由不明の切り替え（switched・unknown）は外す
//   ⑤ 初回のガード（decision_source が guard:first_contact）は数えない（返信の数に混ぜない）
//   ⑥ 線（既定10案件）に加え、95%の幅（Wilson）が重ならない組がある時だけブレインに渡す
//   戻す: REACH_STRICT=off（旧の数え方・旧の渡し方）
// ─────────────────────────────────────────────────────────────────────────────
export function reachStrictEnabled(env: Record<string, string | undefined>): boolean {
  return (env.REACH_STRICT ?? "").trim().toLowerCase() !== "off";
}
/** 割合の95%の幅（Wilson・z=1.96）。n=0 は [0,1] */
export function wilsonInterval(reached: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = reached / n, z2 = z * z;
  const den = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
/** 並べた行の中に、95%の幅が重ならない組が1つでもあるか */
export function hasSeparatedPair(rows: ReadonlyArray<Pick<ReachStatRow, "n" | "reached">>): boolean {
  const iv = rows.map((r) => wilsonInterval(r.reached, r.n));
  for (let i = 0; i < iv.length; i++) for (let j = 0; j < iv.length; j++) if (i !== j && iv[i][0] > iv[j][1]) return true;
  return false;
}

/**
 * ブレインに渡す成約パターンの並び: 段階が合う物を先（今まで通り）→ その中で確定の成約を先 → 元の並び（近さ）。
 * WIN_CONFIRMED_WEIGHT=off の時は段階だけ（旧）
 */
export function orderWinningPatterns<T extends { notes?: string | null; checkpoint_stage?: string | null; outcome_type?: string | null }>(rows: ReadonlyArray<T>, currentStage: string | null | undefined, env: Record<string, string | undefined>): T[] {
  const w = confirmedWinWeightEnabled(env);
  // 2026-10-08 竹内さん: 失注を負の正解にしない＝失注の成約パターン（【失注】避けるべき対応）はブレインに渡さない（LOST_AS_NEGATIVE=on で旧）
  const keepLost = (env.LOST_AS_NEGATIVE ?? "").trim().toLowerCase() === "on";
  return rows.filter((r) => keepLost || r.outcome_type !== "closed_lost").map((r, i) => ({ r, i, s: currentStage && r.checkpoint_stage === currentStage ? 1 : 0, c: w && isConfirmedWinNotes(r.notes) ? 1 : 0 }))
    .sort((a, b) => b.s - a.s || b.c - a.c || a.i - b.i).map((x) => x.r);
}

/** 判断と案件から、場面×段階×判断 → 申込到達率を数える（同じ案件の同じキーは最初の判断だけ） */
export function computeReachStats(points: ReadonlyArray<ReachDecisionPoint>, episodes: ReadonlyArray<ReachEpisode>, opts: { nowMs: number; windowDays?: number; matureDays?: number; strict?: boolean }): ReachStatRow[] {
  if (opts.strict) return computeReachStatsStrict(points, episodes, opts);
  const epMap = new Map(episodes.map((e) => [`${e.conversationId}|${e.episodeNo}`, e]));
  const from = opts.nowMs - (opts.windowDays ?? REACH_WINDOW_DAYS) * DAY;
  const mature = (opts.matureDays ?? REACH_MATURE_DAYS) * DAY;
  const first = new Map<string, { at: number; reached: boolean; won: boolean }>();
  for (const p of points) {
    if (!p.scene || !p.bucket) continue;
    const at = ms(p.at);
    if (!Number.isFinite(at) || at < from) continue;
    const ep = epMap.get(`${p.conversationId}|${p.episodeNo}`);
    if (!ep) continue;
    const applied = ms(ep.appliedAt);
    if (Number.isFinite(applied) && applied <= at) continue; // 申込の後の判断は数えない
    const reached = Number.isFinite(applied) && applied > at;
    const won = reached && !!ep.confirmedWon;
    if (!reached && (ep.result ?? "in_progress") === "in_progress" && opts.nowMs - at < mature) continue; // まだ分からない
    const key = `${p.scene}|${p.bucket}|${reachActionKey(p.action)}|${p.conversationId}|${p.episodeNo}`;
    const prev = first.get(key);
    if (!prev || at < prev.at) first.set(key, { at, reached, won });
  }
  const agg = new Map<string, { n: number; reached: number; won: number }>();
  for (const [key, v] of first) {
    const [scene, bucket, action] = key.split("|");
    const k = `${scene}|${bucket}|${action}`;
    const a = agg.get(k) ?? { n: 0, reached: 0, won: 0 };
    a.n++; if (v.reached) a.reached++; if (v.won) a.won++;
    agg.set(k, a);
  }
  return [...agg.entries()].map(([k, a]) => {
    const [scene_key, stage_bucket, action] = k.split("|");
    return { scene_key, stage_bucket: stage_bucket as StageBucket, action, n: a.n, reached: a.reached, rate: a.n ? Math.round((a.reached / a.n) * 1000) / 1000 : 0, won: a.won };
  }).sort((x, y) => x.scene_key.localeCompare(y.scene_key) || x.stage_bucket.localeCompare(y.stage_bucket) || y.n - x.n || x.action.localeCompare(y.action));
}

/** 厳密な数え方（①〜⑤・上の説明）。行の形は旧と同じ */
function computeReachStatsStrict(points: ReadonlyArray<ReachDecisionPoint>, episodes: ReadonlyArray<ReachEpisode>, opts: { nowMs: number; windowDays?: number; matureDays?: number }): ReachStatRow[] {
  const epMap = new Map(episodes.map((e) => [`${e.conversationId}|${e.episodeNo}`, e]));
  const from = opts.nowMs - (opts.windowDays ?? REACH_WINDOW_DAYS) * DAY;
  const mature = (opts.matureDays ?? REACH_MATURE_DAYS) * DAY;
  // ③ 鍵は 場面|段階|会話|案件（判断は鍵に入れない）＝同じ案件は最初の判断1つだけ
  const first = new Map<string, { at: number; action: string; reached: boolean; won: boolean }>();
  for (const p of points) {
    if (!p.scene || !p.bucket) continue;
    if ((p.src ?? "").startsWith("guard:first_contact")) continue; // ⑤
    const at = ms(p.at);
    if (!Number.isFinite(at) || at < from) continue;
    if (opts.nowMs - at < mature) continue; // ① 30日たっていない判断は、届いた物も届かない物も数えない
    const ep = epMap.get(`${p.conversationId}|${p.episodeNo}`);
    if (!ep) continue;
    if (ep.result === "switched" && ep.switchReason !== "screening_rejected") continue; // ④ 理由不明の切り替えは外す
    const applied = ms(ep.appliedAt);
    if (Number.isFinite(applied) && applied <= at) continue; // 申込の後の判断は数えない
    const reached = Number.isFinite(applied) && applied > at && applied - at <= mature; // ① 30日以内に申込
    const won = reached && !!ep.confirmedWon;
    const key = `${p.scene}|${p.bucket}|${p.conversationId}|${p.episodeNo}`;
    const prev = first.get(key);
    if (!prev || at < prev.at) first.set(key, { at, action: reachActionKey(p.actualAction ?? null), reached, won }); // ② 実際に送った AIX
  }
  const agg = new Map<string, { n: number; reached: number; won: number }>();
  for (const [key, v] of first) {
    const [scene, bucket] = key.split("|");
    const k = `${scene}|${bucket}|${v.action}`;
    const a = agg.get(k) ?? { n: 0, reached: 0, won: 0 };
    a.n++; if (v.reached) a.reached++; if (v.won) a.won++;
    agg.set(k, a);
  }
  return [...agg.entries()].map(([k, a]) => {
    const [scene_key, stage_bucket, action] = k.split("|");
    return { scene_key, stage_bucket: stage_bucket as StageBucket, action, n: a.n, reached: a.reached, rate: a.n ? Math.round((a.reached / a.n) * 1000) / 1000 : 0, won: a.won };
  }).sort((x, y) => x.scene_key.localeCompare(y.scene_key) || x.stage_bucket.localeCompare(y.stage_bucket) || y.n - x.n || x.action.localeCompare(y.action));
}

/**
 * ブレインに渡す1〜数行（場面と段階が合い、線を超えた判断が2つ以上ある時だけ・無ければ ""）。
 *   言い回しの指示は書かない（材料だけ）。いつの集計かを付ける。
 */
export function buildReachNote(rows: ReadonlyArray<ReachStatRow>, scene: string | null | undefined, bucket: StageBucket | null | undefined, opts: { minN: number; computedAt?: string | null; labels?: Record<string, string>; winWeight?: number; strict?: boolean }): string {
  if (!scene || !bucket) return "";
  // 2026-10-08 竹内さん: 確定の成約はより重い正解＝並べ方の点に重みで足す（率の表示は申込到達のまま・確定の成約の数を添える）
  const ww = opts.winWeight ?? 0;
  const hit = rows.filter((r) => r.scene_key === scene && r.stage_bucket === bucket && r.n >= opts.minN)
    .sort((a, b) => reachScore(b, ww) - reachScore(a, ww) || b.rate - a.rate || b.n - a.n || a.action.localeCompare(b.action)).slice(0, 4);
  if (hit.length < 2) return "";
  // ⑥ 厳密: 95%の幅が重ならない組がある時だけ渡す（幅も添える）
  if (opts.strict && !hasSeparatedPair(hit)) return "";
  const range = (r: ReachStatRow) => { if (!opts.strict) return ""; const [lo, hi] = wilsonInterval(r.reached, r.n); return `・95%の幅 ${Math.round(lo * 100)}〜${Math.round(hi * 100)}%`; };
  const label = (a: string) => (a === REPLY_ACTION_KEY ? "返信（AIX なし）" : `AIX ${opts.labels?.[a] ? `${opts.labels[a]}（${a}）` : a}`);
  const when = opts.computedAt ? `・${new Date(ms(opts.computedAt) + 9 * 3600_000).toISOString().slice(5, 10).replace("-", "/")} 集計` : "";
  return [
    `【この場面の実績（申込まで届いた割合・場面「${SCENE_LABEL[scene] ?? scene}」・${STAGE_BUCKET_LABEL[bucket]}${when}）】`,
    ...hit.map((r) => `- ${label(r.action)}: ${Math.round(r.rate * 100)}%（${r.reached}/${r.n}案件${range(r)}${ww > 0 && (r.won ?? 0) > 0 ? `・うち成約確定 ${r.won}` : ""}）`),
    opts.strict ? "※ 過去の案件で、判断から30日以内に申込まで届いた割合（実際に送った AIX で数えた・相関で因果ではない）。どちらにするかは今の会話で決める" : "※ 過去の案件の割合（相関で因果ではない）。どちらにするかは今の会話で決める",
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
export function winningOutcomeTag(outcomeType: string | null | undefined, env: Record<string, string | undefined>, notes?: string | null): string {
  if (outcomeType === "closed_lost") return "【失注】";
  // 2026-10-08 竹内さん: 確定の成約まで行った事例はより重い正解（印 [成約確定]・WIN_CONFIRMED_WEIGHT=off で旧）
  if (confirmedWinWeightEnabled(env) && isConfirmedWinNotes(notes)) return outcomeApplyBasisEnabled(env) ? "【申込に届いた・成約確定】" : "【成約確定】";
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

/**
 * 2026-10-08 竹内さん（決定①「失注内容に深くとらわれたら逆に質が落ちる」の徹底）: 失注（closed_lost）を学習の負の正解にしない。
 *   analyze-closed は失注の会話を分析しない（「失注パターン・避けるべき対応」を ai_reply_knowledge 重要度9/8・winning_patterns に入れない）・
 *   書き戻しでも was_correct=false／closing_strategy_logs.outcome='lost' を付けない（未確定のまま残す）。失注の件数・型は台帳（deal_outcomes）で数える。
 *   戻す: LOST_AS_NEGATIVE=on（旧＝失注も分析して負の事例として入れる）
 */
export function lostAsNegativeEnabled(env: Record<string, string | undefined>): boolean {
  return (env.LOST_AS_NEGATIVE ?? "").trim().toLowerCase() === "on";
}

/**
 * 朝の日報の「🤖 AI貢献率」の1行（2026-10-08 竹内さん: 申込で数える・確定の成約は別に並べる）。
 *   m.basis==="applied" の時は「直近30日申込 N件中 M件」＋確定の成約が1件以上あれば「・成約確定 K件中 L件」。旧の形（成約で数えた値）はそのまま。
 */
export function attributionLineOf(m: { rate?: unknown; total?: unknown; ai_assisted?: unknown; basis?: unknown; won_total?: unknown; won_assisted?: unknown } | null | undefined): string {
  if (!m || typeof m.rate !== "number" || typeof m.total !== "number") return "";
  const pct = Math.round(m.rate * 100);
  const assisted = typeof m.ai_assisted === "number" ? m.ai_assisted : 0;
  if (m.basis === "applied") {
    const wonTotal = typeof m.won_total === "number" ? m.won_total : 0;
    const wonAssisted = typeof m.won_assisted === "number" ? m.won_assisted : 0;
    return `🤖 AI貢献率: ${pct}%（直近30日申込${m.total}件中${assisted}件AI貢献${wonTotal > 0 ? `・成約確定${wonTotal}件中${wonAssisted}件` : ""}）`;
  }
  return `🤖 AI貢献率: ${pct}%（直近30日成約${m.total}件中${assisted}件AI貢献）`;
}
