/**
 * 人間（通常録画）と自動の近さ差分（2026-11-17 統括Pro）
 *
 *   Pro生: 「近さ加重スコアが手元計算のみで統括束に未接続」
 *         「完了線（許可線）の数値基準が未定義」
 *         「F26/F27/F28を統括束に接続し、近さ加重スコアを自動計算」
 *
 * ★ 純関数。DBに書かない。ops.g から測る。
 */

export type NearnessBucket = {
  ops: number;
  gN: number;
  /** g>0 かつ g<400 の割合（%） */
  fast400pct: number | null;
  /** 700〜2000ms の割合（%） */
  humanBandPct: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  cv: number | null;
};

export type NearnessScore = {
  /** 0〜100（通常を基準にした加重） */
  total: number;
  fastScore: number;
  hbScore: number;
  p50Score: number;
  cvScore: number;
};

export type HumanNearness = {
  at: string;
  normal: NearnessBucket;
  auto: NearnessBucket;
  score: NearnessScore;
  /** 許可線（自動検索に渡してよいかの数値） */
  allow: {
    scoreMin: number;
    fast400MaxPct: number;
    humanBandMinPct: number;
  };
  /** 許可線を満たすか */
  allowed: boolean;
  /** 足りない所（短い） */
  gaps: string[];
  line: string;
};

/**
 * ★ 許可線（統括Pro 2026-11-17）
 *   近さ32→70を目指す／短間隔完了線≤12%／human帯は人の半分超を当面の許可下限
 */
export const NEARNESS_ALLOW = {
  scoreMin: 70,
  fast400MaxPct: 12,
  humanBandMinPct: 50,
} as const;

/** スコア加重（手元計算と同じ式を束・F29で共有） */
export const NEARNESS_WEIGHTS = {
  fast: 0.4,
  humanBand: 0.3,
  p50: 0.15,
  cv: 0.15,
} as const;

function pct(a: number, b: number): number | null {
  return b ? Math.round((1000 * a) / b) / 10 : null;
}
function pAt(gs: number[], q: number): number | null {
  if (!gs.length) return null;
  return gs[Math.min(gs.length - 1, Math.floor(gs.length * q))];
}
function cvOf(gs: number[]): number | null {
  if (gs.length < 2) return null;
  const m = gs.reduce((a, b) => a + b, 0) / gs.length;
  if (!m) return null;
  const v = gs.reduce((a, b) => a + (b - m) ** 2, 0) / gs.length;
  return Math.round((Math.sqrt(v) / m) * 100) / 100;
}

export function bucketGaps(gaps: number[]): NearnessBucket {
  const gs = gaps.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const fast400 = gs.filter((n) => n > 0 && n < 400).length;
  const humanBand = gs.filter((n) => n >= 700 && n <= 2000).length;
  return {
    ops: gs.length,
    gN: gs.length,
    fast400pct: pct(fast400, gs.length),
    humanBandPct: pct(humanBand, gs.length),
    p10: pAt(gs, 0.1),
    p50: pAt(gs, 0.5),
    p90: pAt(gs, 0.9),
    cv: cvOf(gs),
  };
}

export function scoreNearness(auto: NearnessBucket, human: NearnessBucket): NearnessScore {
  const fastH = Number(human.fast400pct) || 1.4;
  const fastA = Number(auto.fast400pct);
  let fastScore = 100;
  if (Number.isFinite(fastA)) {
    const over = Math.max(0, fastA - fastH);
    fastScore = Math.max(0, Math.round(100 - over * 2.5));
  }
  const hbH = Number(human.humanBandPct) || 79;
  const hbA = Number(auto.humanBandPct) || 0;
  const hbScore = Math.max(0, Math.min(100, Math.round((hbA / hbH) * 100)));
  const pH = Number(human.p50) || 1117;
  const pA = Number(auto.p50) || 0;
  const pDiff = pA > 0 ? Math.abs(pA - pH) / pH : 1;
  const p50Score = Math.max(0, Math.round(100 - pDiff * 100));
  const cvA = Number(auto.cv);
  const cvScore =
    cvA == null || !(auto.gN >= 30)
      ? 40
      : cvA >= 0.4 && cvA <= 1.2
        ? 100
        : cvA < 0.4
          ? Math.round(cvA * 200)
          : Math.max(0, Math.round(100 - (cvA - 1.2) * 80));
  const total = Math.round(
    fastScore * NEARNESS_WEIGHTS.fast +
      hbScore * NEARNESS_WEIGHTS.humanBand +
      p50Score * NEARNESS_WEIGHTS.p50 +
      cvScore * NEARNESS_WEIGHTS.cv,
  );
  return { total, fastScore, hbScore, p50Score, cvScore };
}

export function gapsFromOps(ops: ReadonlyArray<Record<string, unknown>> | null | undefined): number[] {
  if (!Array.isArray(ops)) return [];
  const out: number[] = [];
  for (const o of ops) {
    const g = Number(o?.g);
    if (Number.isFinite(g) && g >= 0) out.push(g);
  }
  return out;
}

export function computeHumanNearness(input: {
  normalGaps: number[];
  autoGaps: number[];
  nowMs?: number;
}): HumanNearness {
  const normal = bucketGaps(input.normalGaps);
  const auto = bucketGaps(input.autoGaps);
  const score = scoreNearness(auto, normal);
  const allow = {
    scoreMin: NEARNESS_ALLOW.scoreMin,
    fast400MaxPct: NEARNESS_ALLOW.fast400MaxPct,
    humanBandMinPct: NEARNESS_ALLOW.humanBandMinPct,
  };
  const gaps: string[] = [];
  if (score.total < allow.scoreMin) gaps.push(`近さ${score.total}<${allow.scoreMin}`);
  if ((auto.fast400pct ?? 100) > allow.fast400MaxPct) {
    gaps.push(`短間隔${auto.fast400pct}%>${allow.fast400MaxPct}%`);
  }
  if ((auto.humanBandPct ?? 0) < allow.humanBandMinPct) {
    gaps.push(`human帯${auto.humanBandPct}%<${allow.humanBandMinPct}%`);
  }
  const allowed =
    score.total >= allow.scoreMin &&
    (auto.fast400pct ?? 100) <= allow.fast400MaxPct &&
    (auto.humanBandPct ?? 0) >= allow.humanBandMinPct &&
    auto.gN >= 30 &&
    normal.gN >= 30;
  const line = [
    `近さ${score.total}点（許可≥${allow.scoreMin}${allowed ? "・許可OK" : "・未達"}）`,
    `短間隔 自動${auto.fast400pct ?? "-"}%／通常${normal.fast400pct ?? "-"}%（許可≤${allow.fast400MaxPct}%）`,
    `human帯 自動${auto.humanBandPct ?? "-"}%／通常${normal.humanBandPct ?? "-"}%（許可≥${allow.humanBandMinPct}%）`,
    `p50 自動${auto.p50 ?? "-"}／通常${normal.p50 ?? "-"}`,
    `標本 自動g=${auto.gN} 通常g=${normal.gN}`,
  ].join("／");
  return {
    at: new Date(input.nowMs ?? Date.now()).toISOString(),
    normal,
    auto,
    score,
    allow,
    allowed,
    gaps,
    line,
  };
}

/** Motion行（mode + shot_ops）から近さを出す */
export function nearnessFromMotionRows(
  rows: ReadonlyArray<{ mode?: unknown; shot_ops?: unknown }>,
  nowMs?: number,
): HumanNearness | null {
  const normalGaps: number[] = [];
  const autoGaps: number[] = [];
  for (const r of rows) {
    const m = String(r.mode ?? "").toLowerCase();
    const ops = Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [];
    const gs = gapsFromOps(ops);
    if (!gs.length) continue;
    if (m === "aix" || m === "auto") autoGaps.push(...gs);
    else if (m === "normal") normalGaps.push(...gs);
  }
  if (normalGaps.length < 10 && autoGaps.length < 10) return null;
  return computeHumanNearness({ normalGaps, autoGaps, nowMs });
}
