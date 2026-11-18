/**
 * 統括が「作業員を何人に増やすか」を数字から決める（純関数・2026-11-18 竹内さん）
 *
 * ⚠ Cursor 作業員を勝手に起動しない。推奨人数だけ出す。
 */

/** 硬上限（無限増殖を防ぐ・拡張・DB・写真学習の並列は現場で6人まで想定） */
export const WORKER_SCALE_CAP = 6;

export type WorkerScaleInput = {
  weakN: number;
  unreadNormal: number;
  learningTasksN: number;
  foundationGapsN: number;
  /** 同時に動かせるサイト数（realpro/itandi/reins 等） */
  sitesParallel: number;
  currentWorkers?: number;
  /** 課題が拡張再読込1手だけで止まっている */
  reloadOnlyBottleneck?: boolean;
};

export type WorkerScaleResult = {
  recommend: number;
  why: string;
  parallelizable: number;
  cap: number;
};

const SITE_KEYS = ["realpro", "itandi", "reins"] as const;

/** 記録があるサイト数（並列レーンの下限） */
export function countSitesParallel(siteCounts: Record<string, number>): number {
  const n = SITE_KEYS.filter((k) => (siteCounts[k] || 0) > 0).length;
  if (n > 0) return n;
  const other = Object.entries(siteCounts).filter(([k, v]) => k && k !== "(空)" && (v || 0) > 0).length;
  return other > 0 ? 1 : 0;
}

/**
 * 並列できる独立課題のおおよその数。
 * - サイト別は別レーン（拡張・手順が分かれる）
 * - 学習課題が複数 kind なら別レーンに足す（最大+2）
 * - 土台の抜けが複数なら点検と実装を分けられる
 */
export function countParallelizableWork(inp: Pick<WorkerScaleInput, "sitesParallel" | "learningTasksN" | "foundationGapsN" | "weakN" | "unreadNormal">): number {
  let p = Math.max(0, inp.sitesParallel);
  if (inp.learningTasksN >= 2) p += Math.min(inp.learningTasksN - 1, 2);
  if (inp.foundationGapsN >= 2) p += 1;
  if (inp.weakN >= 4 && inp.unreadNormal >= 5) p += 1;
  return Math.min(WORKER_SCALE_CAP, Math.max(0, p));
}

/** 推奨作業員数と理由 */
export function recommendWorkerScale(inp: WorkerScaleInput): WorkerScaleResult {
  const cap = WORKER_SCALE_CAP;
  const parallelizable = countParallelizableWork(inp);
  const reasons: string[] = [];

  if (inp.learningTasksN <= 1 && inp.reloadOnlyBottleneck) {
    return {
      recommend: 1,
      why: "独立課題≤1・ボトルネックは拡張再読込の1手だけ（増員しても待ちが減らない）",
      parallelizable,
      cap,
    };
  }

  let recommend = 1;

  if (parallelizable >= 3) {
    recommend = Math.max(recommend, 2);
    reasons.push(`並列できる独立課題≈${parallelizable}（≥3）`);
  }

  if (inp.weakN >= 8) {
    recommend += 1;
    reasons.push(`弱い欄${inp.weakN}件≥8`);
  }
  if (inp.unreadNormal >= 20) {
    recommend += 1;
    reasons.push(`未学習写真${inp.unreadNormal}枚≥20`);
  }
  if (inp.learningTasksN >= 4) {
    recommend += 1;
    reasons.push(`学習課題${inp.learningTasksN}件≥4`);
  }

  recommend = Math.min(cap, Math.max(1, recommend));

  if (recommend === 1 && !reasons.length) {
    reasons.push(`並列≈${parallelizable}・課題量は現状1人で足りる`);
  }

  const why = reasons.join("／");
  return { recommend, why, parallelizable, cap };
}