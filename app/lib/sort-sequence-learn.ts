/**
 * 並べ替え（AD・高→低）を連続録画から理解できるまで学ぶ（F53）
 *
 * 竹内さん 2026-11-23:
 *   「徹底して録画から必要なら連続学習でおこなう／並べ替えのところも連続録画から学習したら理解できる／理解できるまで徹底／仕組みもちゃんと理解して作る」
 *
 * 仕組み:
 *   ① 通常録画の shot_ops に sort_detail / 高→低 がある run を洗い出す
 *   ② main_table「棟戸並べ替え」は誤認（列見出しとは別物）→ 学習焦点・理解完了線に使わない
 *   ③ order=sequence でランを先頭→末尾読み（未学習を優先）
 *   ④ 束に sort_detail / 高→低 の xy が載り、未学習の sort ランが 0 になるまで周回
 */
import { shotKeyRunId, isShotLearnOk, shotLearnHasSceneFlow } from "./learn-foundation-audit";

/** 本物の並べ替え操作（列見出し・高→低）。棟一覧の「並べ替え」文言は含めない */
export const SORT_REAL_NEEDLES = ["sort_detail", "高→低"] as const;

/** 束 points の誤認キー（棟戸の main_table 文言） */
export const SORT_FALSE_POINT_RE = /棟\d*戸.*並べ替え|並べ替え更新｜div\.main_table|並べ替え｜div\.(main_table|under)/;

export const SORT_FOCUS_FIELDS = ["sort_detail", "高→低", "並べ替え｜span", "AD"] as const;

export type SortRunStat = {
  run_id: string;
  n: number;
  withShot: number;
  learned: number;
  withScene: number;
  /** ラン全体の未学習枚（棟戸「並べ替え」含む・参考） */
  unlearnedShot: number;
  /** 本物 sort_detail/高→低 のショット数 */
  realShot: number;
  /** 本物のうち未学習 */
  realUnlearned: number;
  hasRealSort: boolean;
  hits: string[];
};

export type SortUnderstandGate = {
  ok: boolean;
  realPointKeys: string[];
  falsePointKeys: string[];
  unlearnedRealRuns: number;
  line: string;
  next: string;
};

function blobHasRealSort(blob: string): boolean {
  return SORT_REAL_NEEDLES.some((n) => blob.includes(n));
}

function hitList(blob: string): string[] {
  const out: string[] = [];
  for (const n of ["並べ替え", "sort_detail", "高→低", "AD"]) {
    if (blob.includes(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

export function isFalseSortPointKey(key: string): boolean {
  return SORT_FALSE_POINT_RE.test(String(key || ""));
}

/** 通常行から並べ替え関連 run を集計 */
export function tallySortRuns(
  rows: Array<{
    mode?: unknown;
    shot_key?: unknown;
    shot_taken?: unknown;
    shot_learn?: unknown;
    shot_ops?: unknown;
    kinds?: unknown;
    fields?: unknown;
    point_fields?: unknown;
  }>,
): SortRunStat[] {
  const buckets = new Map<
    string,
    {
      n: number;
      withShot: number;
      learned: number;
      withScene: number;
      realShot: number;
      realLearned: number;
      hasRealSort: boolean;
      hits: Set<string>;
    }
  >();

  for (const r of rows) {
    if (String(r.mode || "").toLowerCase() !== "normal") continue;
    const blob = JSON.stringify({
      kinds: r.kinds,
      fields: r.fields,
      point_fields: r.point_fields,
      shot_ops: r.shot_ops,
      shot_learn: r.shot_learn,
    });
    const hits = hitList(blob);
    if (!hits.length) continue;
    const run = shotKeyRunId(String(r.shot_key || "")) || "no_run";
    if (run === "no_run") continue;
    const b = buckets.get(run) || {
      n: 0,
      withShot: 0,
      learned: 0,
      withScene: 0,
      realShot: 0,
      realLearned: 0,
      hasRealSort: false,
      hits: new Set<string>(),
    };
    b.n++;
    const hasShot = !!(r.shot_taken || r.shot_key);
    const learned = isShotLearnOk(r.shot_learn);
    if (hasShot) b.withShot++;
    if (learned) b.learned++;
    if (shotLearnHasSceneFlow(r.shot_learn)) b.withScene++;
    const real = blobHasRealSort(blob);
    if (real) {
      b.hasRealSort = true;
      if (hasShot) b.realShot++;
      if (hasShot && learned) b.realLearned++;
    }
    for (const h of hits) b.hits.add(h);
    buckets.set(run, b);
  }

  return [...buckets.entries()]
    .map(([run_id, b]) => ({
      run_id,
      n: b.n,
      withShot: b.withShot,
      learned: b.learned,
      withScene: b.withScene,
      unlearnedShot: Math.max(0, b.withShot - b.learned),
      realShot: b.realShot,
      realUnlearned: Math.max(0, b.realShot - b.realLearned),
      hasRealSort: b.hasRealSort,
      hits: [...b.hits],
    }))
    .sort((a, b) => {
      if (a.hasRealSort !== b.hasRealSort) return a.hasRealSort ? -1 : 1;
      return b.realUnlearned - a.realUnlearned || b.withShot - a.withShot;
    });
}

/** 束キーが本物の並べ替え列見出しか */
export function isRealSortPointKey(key: string): boolean {
  const k = String(key || "");
  if (isFalseSortPointKey(k)) return false;
  return /sort_detail|高→低|^AD$|並べ替え｜span|span\.sort_detail/i.test(k);
}

/**
 * 通常 shot_ops から並べ替え座標を収穫（無料・Vision不要）
 * 実測: f=`左の高→低｜span.sort_detail` x≈0.16 y≈0.27
 */
export function harvestSortPointsFromOps(
  rows: Array<{ mode?: unknown; shot_ops?: unknown }>,
): Record<string, { x: number; y: number; n: number; w?: string }> {
  const acc = new Map<string, { xs: number[]; ys: number[]; n: number; w?: string }>();
  const bump = (key: string, x: number, y: number, w?: string) => {
    const cur = acc.get(key) || { xs: [], ys: [], n: 0, w };
    cur.xs.push(x);
    cur.ys.push(y);
    cur.n++;
    if (w) cur.w = w;
    acc.set(key, cur);
  };
  for (const r of rows) {
    if (String(r.mode || "").toLowerCase() !== "normal") continue;
    const ops = Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [];
    for (const o of ops) {
      const f = String(o.f || "");
      if (!/sort_detail|高→低/.test(f)) continue;
      if (isFalseSortPointKey(f)) continue;
      const x = Number(o.x);
      const y = Number(o.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const w = String(o.w || "button");
      bump(f, x, y, w);
      for (const a of ["sort_detail", "高→低", "AD高→低", "左の高→低｜span.sort_detail"]) {
        if (a !== f) bump(a, x, y, w);
      }
    }
  }
  const mid = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 0;
  };
  const out: Record<string, { x: number; y: number; n: number; w?: string }> = {};
  for (const [k, v] of acc) {
    out[k] = { x: mid(v.xs), y: mid(v.ys), n: v.n, w: v.w };
  }
  return out;
}

/** 理解完了線: 本物の列見出し points があり、本物 sort の未学習 run が 0 */
export function evaluateSortUnderstandGate(opt: {
  points: Record<string, { x?: number; y?: number; n?: number } | undefined> | null | undefined;
  runs: SortRunStat[];
}): SortUnderstandGate {
  const pts = opt.points || {};
  const realPointKeys: string[] = [];
  const falsePointKeys: string[] = [];
  for (const [k, v] of Object.entries(pts)) {
    if (typeof v?.x !== "number" || typeof v?.y !== "number") continue;
    if (isFalseSortPointKey(k)) {
      falsePointKeys.push(k);
      continue;
    }
    if (isRealSortPointKey(k)) {
      realPointKeys.push(k);
    }
  }
  /** 本物 sort ショットがまだ読めないランだけ（棟戸だけの未読は数えない） */
  const unlearnedReal = opt.runs.filter((r) => r.hasRealSort && r.realUnlearned > 0);
  const ok = realPointKeys.length >= 1 && unlearnedReal.length === 0;
  const line = ok
    ? `並べ替え理解✓ 本物points=${realPointKeys.length} 本物未読ラン=0（誤認points=${falsePointKeys.length}）`
    : `並べ替え理解✗ 本物points=${realPointKeys.length} 本物未読ラン=${unlearnedReal.length} 誤認points=${falsePointKeys.length}`;
  const next = ok
    ? "拡張再読込→自動1回で ad_sort_hover / aim有 を確認"
    : unlearnedReal.length
      ? `order=sequence で本物未読を読む（例: ${unlearnedReal[0].run_id}・本物残${unlearnedReal[0].realUnlearned}枚）`
      : "束に sort_detail/高→低 の xy を載せる（ops収穫 or flash）";
  return { ok, realPointKeys, falsePointKeys, unlearnedRealRuns: unlearnedReal.length, line, next };
}

/** 統括が名指しした run を優先しつつ、本物 sort の未学習を並べる */
export function pickSortRunsToLearn(
  runs: SortRunStat[],
  preferRunIds: string[] = [],
  maxRuns = 4,
): SortRunStat[] {
  const prefer = new Set(preferRunIds.map((s) => s.replace(/^run_/, "")));
  const real = runs.filter((r) => r.hasRealSort && r.realUnlearned > 0);
  const ranked = [...real].sort((a, b) => {
    const ap = prefer.has(a.run_id.replace(/^run_/, "")) || [...prefer].some((p) => a.run_id.includes(p)) ? 1 : 0;
    const bp = prefer.has(b.run_id.replace(/^run_/, "")) || [...prefer].some((p) => b.run_id.includes(p)) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return b.realUnlearned - a.realUnlearned;
  });
  return ranked.slice(0, maxRuns);
}

/** 誤認の棟戸並べ替え points を落とす（本物キーは残す） */
export function stripFalseSortPoints<T extends { x?: number; y?: number; n?: number }>(
  points: Record<string, T> | null | undefined,
): { points: Record<string, T>; removed: string[] } {
  const out: Record<string, T> = { ...(points || {}) };
  const removed: string[] = [];
  for (const k of Object.keys(out)) {
    if (isFalseSortPointKey(k)) {
      removed.push(k);
      delete out[k];
    }
  }
  return { points: out, removed };
}
