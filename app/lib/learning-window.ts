// app/lib/learning-window.ts
// 毎週の学習の窓（2026-10-08 竹内さんの決定の2「毎週の学習の窓を 30日に広げる」）。純関数・DB/LLM なし・画面からも読める。
//
// 旧: weekly-learning（7日）・aix-weekly-learning（7日／線引きは14日）・prompt-candidate-gen（7日／AIXのずれ14日）・
//     auto-star-winners（14日）・auto-analyze-losers（14日）がそれぞれ短い窓で学んでいた。
// 新: 窓は 30日。ただし鮮度を落とさないよう「新しい7日」と「前の23日」を分けて扱う:
//   ・LLM に渡す件数は「新しい7日を先に埋める（recentMax）＋前の23日は上限つき（olderMax）」＝費用が増えすぎない
//   ・LLM に渡す例には【新しい7日】【前の23日】の札を付け、指示で「新しい7日は2点・前の23日は1点」と数えさせる
//   ・「2件以上くり返したらルールにする」等の件数の線は重み付きで数える（新しい7日×2・前の23日×1）
//       旧の線「新しい N 件以上」＝重み 2N。新しい窓の線は 2N−1（1件だけ新しい物は通らない・新1＋前1 や 前だけ 2N−1件は通る）
//   ・件数の比べ（線引きの質問の「14日で3件」等）は、重み付きの件数を旧の窓の長さにならして比べる（同じ頻度なら旧と同じ所で鳴る）
// 戻す: LEARNING_WINDOW_30D=off（全部）／LEARNING_WINDOW_30D=weekly-learning,auto-star-winners（名前を並べた cron だけ旧の窓）
//       LEARNING_WINDOW_DAYS=N で広い窓の長さを変える（N が旧の窓以下＝例 7 なら旧の窓に戻る・上限 90）

export const LEARNING_RECENT_DAYS = 7;
export const LEARNING_WIDE_DAYS_DEFAULT = 30;
const LEARNING_WIDE_DAYS_MAX = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type LearningCron =
  | "weekly-learning"
  | "aix-weekly-learning"
  | "prompt-candidate-gen"
  | "auto-star-winners"
  | "auto-analyze-losers";

export type LearningWindow = {
  cron: string;
  /** true = 旧の窓（分けない・全部「新しい」扱い・札も付けない） */
  legacy: boolean;
  days: number;
  recentDays: number;
  nowMs: number;
  sinceMs: number;
  recentSinceMs: number;
  sinceIso: string;
  recentSinceIso: string;
};

type Env = Record<string, string | undefined>;
type TimeLike = string | number | Date | null | undefined;

/** LEARNING_WINDOW_30D の値で、この cron が旧の窓か */
export function learningWindowOff(cron: string, env: Env = process.env): boolean {
  const v = String(env.LEARNING_WINDOW_30D ?? "").trim().toLowerCase();
  if (!v) return false;
  if (["off", "0", "false", "no", "legacy"].includes(v)) return true;
  return v.split(/[,\s]+/).filter(Boolean).includes(cron.toLowerCase());
}

/**
 * この cron の学習の窓。legacyDays は旧の窓の日数（7 か 14）。
 * 旧の窓のとき days=legacyDays・recentDays=legacyDays（全部が「新しい」＝重みは全部2＝旧と同じ数え方）。
 */
export function learningWindow(
  cron: string,
  legacyDays: number,
  opts: { now?: TimeLike; env?: Env } = {},
): LearningWindow {
  const env = opts.env ?? process.env;
  const nowMs = toMs(opts.now) ?? Date.now();
  let wide = LEARNING_WIDE_DAYS_DEFAULT;
  const raw = env.LEARNING_WINDOW_DAYS;
  if (raw != null && String(raw).trim() !== "") {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n > 0) wide = Math.min(n, LEARNING_WIDE_DAYS_MAX);
  }
  const legacy = learningWindowOff(cron, env) || wide <= legacyDays;
  const days = legacy ? legacyDays : wide;
  const recentDays = legacy ? legacyDays : Math.min(LEARNING_RECENT_DAYS, days);
  const sinceMs = nowMs - days * DAY_MS;
  const recentSinceMs = nowMs - recentDays * DAY_MS;
  return {
    cron, legacy, days, recentDays, nowMs, sinceMs, recentSinceMs,
    sinceIso: new Date(sinceMs).toISOString(),
    recentSinceIso: new Date(recentSinceMs).toISOString(),
  };
}

function toMs(t: TimeLike): number | null {
  if (t == null) return null;
  if (t instanceof Date) return Number.isFinite(t.getTime()) ? t.getTime() : null;
  if (typeof t === "number") return Number.isFinite(t) ? t : null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/** 新しい7日（旧の窓では窓の中は全部「新しい」）。時刻が無い・読めない物は前の扱い */
export function isRecent(w: LearningWindow, t: TimeLike): boolean {
  const ms = toMs(t);
  if (ms == null) return false;
  return ms >= w.recentSinceMs;
}

/** 新しい7日=2・前の23日=1 */
export function recencyWeight(w: LearningWindow, t: TimeLike): 2 | 1 {
  return isRecent(w, t) ? 2 : 1;
}

export function weightedCount(w: LearningWindow, times: TimeLike[]): number {
  return times.reduce<number>((s, t) => s + recencyWeight(w, t), 0);
}

/** 旧の線「新しい legacyMin 件以上」を重み付きの線にした値（2N−1） */
export function recurrenceThreshold(legacyMin: number): number {
  return Math.max(1, 2 * legacyMin - 1);
}

/** 重み付きで「くり返した」と言えるか（旧の窓では 件数 >= legacyMin と同じ） */
export function meetsRecurrence(w: LearningWindow, times: TimeLike[], legacyMin: number): boolean {
  return weightedCount(w, times) >= recurrenceThreshold(legacyMin);
}

/**
 * 重み付きの件数を「perDays 日あたり」にならした件数（旧の線と比べる用）。
 * 同じ頻度で起きていれば旧の窓の件数と同じになる。旧の窓（全部新しい）では件数×perDays/days。
 */
export function equivalentCount(w: LearningWindow, times: TimeLike[], perDays: number): number {
  const denom = w.recentDays * 2 + Math.max(0, w.days - w.recentDays);
  if (denom <= 0) return 0;
  return (weightedCount(w, times) * perDays) / denom;
}

export function splitByRecency<T>(w: LearningWindow, rows: readonly T[], timeOf: (r: T) => TimeLike): { recent: T[]; older: T[] } {
  const recent: T[] = [];
  const older: T[] = [];
  for (const r of rows) {
    const ms = toMs(timeOf(r));
    if (ms != null && ms < w.sinceMs) continue; // 窓の外は捨てる
    (isRecent(w, timeOf(r)) ? recent : older).push(r);
  }
  return { recent, older };
}

/**
 * LLM に渡す例を選ぶ: 新しい7日は渡された順のまま最大 recentMax 件、前の23日は最大 olderMax 件。
 * 前の23日は prefer に当たる物を先に、残りは古い→新しいに並べて等間隔に拾う（23日の中で偏らない）。
 * 返す並びは「新しい7日 → 前の23日」。旧の窓では全部が新しい＝recentMax 件だけ（旧と同じ）。
 */
export function pickRecentFirst<T>(
  w: LearningWindow,
  rows: readonly T[],
  timeOf: (r: T) => TimeLike,
  opts: { recentMax: number; olderMax: number; prefer?: (r: T) => boolean },
): T[] {
  const { recent, older } = splitByRecency(w, rows, timeOf);
  const pickedRecent = recent.slice(0, Math.max(0, opts.recentMax));
  const olderMax = Math.max(0, opts.olderMax);
  if (olderMax === 0 || older.length === 0) return pickedRecent;
  const preferred = opts.prefer ? older.filter((r) => opts.prefer!(r)) : [];
  const rest = opts.prefer ? older.filter((r) => !opts.prefer!(r)) : [...older];
  const pickedOlder = preferred.slice(0, olderMax);
  const remain = olderMax - pickedOlder.length;
  if (remain > 0 && rest.length > 0) {
    const sorted = [...rest].sort((a, b) => (toMs(timeOf(a)) ?? 0) - (toMs(timeOf(b)) ?? 0));
    pickedOlder.push(...spread(sorted, remain));
  }
  return [...pickedRecent, ...pickedOlder];
}

/** 並んだ物から n 件を等間隔に（両端を含む・決定論） */
function spread<T>(sorted: T[], n: number): T[] {
  if (n >= sorted.length) return sorted;
  if (n <= 0) return [];
  if (n === 1) return [sorted[sorted.length - 1]];
  const out: T[] = [];
  const step = (sorted.length - 1) / (n - 1);
  const used = new Set<number>();
  for (let i = 0; i < n; i++) {
    const idx = Math.round(i * step);
    if (!used.has(idx)) { used.add(idx); out.push(sorted[idx]); }
  }
  return out;
}

/** 例に付ける札（旧の窓では空） */
export function recencyTag(w: LearningWindow, t: TimeLike): string {
  if (w.legacy) return "";
  return isRecent(w, t) ? `【新しい${w.recentDays}日】` : `【前の${w.days - w.recentDays}日】`;
}

/** 「直近30日（新しい7日 a件・前の23日 b件）」。旧の窓では「直近7日」 */
export function windowCountsLabel(w: LearningWindow, recentN?: number, olderN?: number): string {
  if (w.legacy) return `直近${w.days}日`;
  const olderDays = w.days - w.recentDays;
  if (recentN == null || olderN == null) return `直近${w.days}日（新しい${w.recentDays}日と前の${olderDays}日）`;
  return `直近${w.days}日（新しい${w.recentDays}日 ${recentN}件・前の${olderDays}日 ${olderN}件）`;
}

/**
 * LLM への数え方の指示（旧の窓では空文字）。legacyMin は旧の「N件以上くり返したら」の N。
 */
export function weightingInstruction(w: LearningWindow, legacyMin: number): string {
  if (w.legacy) return "";
  const olderDays = w.days - w.recentDays;
  const th = recurrenceThreshold(legacyMin);
  return [
    `【数え方（新しい${w.recentDays}日を重く）】`,
    `- 例は【新しい${w.recentDays}日】と【前の${olderDays}日】に分けてある。同じパターンを数える時は【新しい${w.recentDays}日】の例を2点・【前の${olderDays}日】の例を1点とし、合計${th}点以上の時だけ「くり返したパターン」として扱う。`,
    `- 【前の${olderDays}日】にしか無いパターンは、前の週までに学び済み・もう直っている事がある。【新しい${w.recentDays}日】にも出ている（まだ直っていない）パターンを優先する。`,
    `- 新しい${w.recentDays}日と前の${olderDays}日で食い違う時は、新しい${w.recentDays}日の形を正とする（決まりが変わった可能性が高い）。`,
  ].join("\n");
}
