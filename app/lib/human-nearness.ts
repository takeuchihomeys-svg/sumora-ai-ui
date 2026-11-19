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

/**
 * 操作と操作の間の間隔だけを取る（2026-11-17 統括Pro・人間自動化土台）。
 *
 *   ⚠ 旧は change / diag の g も全部入れていた。
 *     click→change は同じ押しの直後なので g が数十msになり、
 *     短間隔%が人工的に跳ねて F28/F29 が「未達」のまま直らない。
 *   → **click/tap/key の開始**だけを動作として数え、その g を使う。
 */
export function gapsFromOps(ops: ReadonlyArray<Record<string, unknown>> | null | undefined): number[] {
  if (!Array.isArray(ops)) return [];
  const out: number[] = [];
  for (const o of ops) {
    const k = String(o?.k ?? "").toLowerCase();
    if (!(k === "click" || k === "tap" || k === "key")) continue;
    const g = Number(o?.g);
    if (Number.isFinite(g) && g >= 0) out.push(g);
  }
  return out;
}

/** 1押下に畳む窓（ms）。自動は1回の押下が2〜3本の click 記録になる（別経路の記録） */
export const PRESS_FOLD_MS = 300;

export type PressOpRow = {
  install_id?: unknown;
  mode?: unknown;
  shot_ops?: unknown;
};

export type PressGapStat = {
  /** 1押下（塊の先頭）どうしの差 */
  gaps: number[];
  /** 重複除去の前（行ごとに足した click/tap/key の数） */
  rawOps: number;
  /** 重複除去の後（click/tap/key のみ） */
  uniqueOps: number;
  /** 畳む前の click/tap/key の数（重複除去後・t あり） */
  beforeFold: number;
  /** 畳んだ後の押下数 */
  presses: number;
  /** t が無くて数えられなかった操作 */
  noT: number;
};

const PRESS_KINDS = new Set(["click", "tap", "key"]);

/**
 * 行をまたいで重複を除き、1押下に畳んだ「押す間隔」を群ごとに出す（純関数）。
 *
 *   ⚠ 写真ごとに直前60件の操作の輪を shot_ops に丸ごと入れているため、
 *     行ごとに数えると同じ操作を26〜58倍重ねて数える。
 *   ⚠ 自動は1回の押下が2〜3本の click 記録になる（名前の形が違う別経路）。
 *
 *   1. click/tap/key だけ（step/diag/change は外す。g=1〜2ms の step が p50 を潰す）
 *   2. 重複除去: 鍵 = install_id + t + k + f（install_id が無ければ t+k+f）
 *   3. 群（install_id × classify の戻り値）ごとに t 順に並べ、
 *      「300ms 以内に続く click/tap」を1押下に畳む（key は畳まない）
 *   4. 塊の先頭どうしの t の差 = 間隔
 *
 * classify が null を返した操作は数えない。
 */
export function pressGapsFromRows(
  rows: ReadonlyArray<PressOpRow> | null | undefined,
  classify: (row: PressOpRow, op: Record<string, unknown>) => string | null,
  foldMs: number = PRESS_FOLD_MS,
): Record<string, PressGapStat> {
  const out: Record<string, PressGapStat> = {};
  const seen = new Set<string>();
  const groups = new Map<string, { cls: string; ops: Array<{ t: number; k: string }> }>();
  const stat = (cls: string): PressGapStat =>
    (out[cls] ||= { gaps: [], rawOps: 0, uniqueOps: 0, beforeFold: 0, presses: 0, noT: 0 });

  for (const r of rows || []) {
    const ops = Array.isArray(r?.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [];
    const inst = r?.install_id == null ? "" : String(r.install_id);
    for (const o of ops) {
      const k = String(o?.k ?? "").toLowerCase();
      if (!PRESS_KINDS.has(k)) continue;
      const cls = classify(r, o);
      if (!cls) continue;
      const s = stat(cls);
      s.rawOps++;
      const t = Number(o?.t);
      if (!Number.isFinite(t)) {
        s.noT++;
        continue;
      }
      const key = `${inst}|${t}|${k}|${String(o?.f ?? "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      s.uniqueOps++;
      const gk = `${inst}#${cls}`;
      let g = groups.get(gk);
      if (!g) {
        g = { cls, ops: [] };
        groups.set(gk, g);
      }
      g.ops.push({ t, k });
    }
  }

  for (const g of groups.values()) {
    const s = stat(g.cls);
    const ops = g.ops.sort((a, b) => a.t - b.t);
    s.beforeFold += ops.length;
    let prevHead: number | null = null;
    let lastClickT: number | null = null;
    for (const o of ops) {
      const isClick = o.k === "click" || o.k === "tap";
      if (isClick && lastClickT != null && o.t - lastClickT <= foldMs) {
        lastClickT = o.t; // 同じ押下の続き（別経路の記録）
        continue;
      }
      s.presses++;
      if (prevHead != null) s.gaps.push(o.t - prevHead);
      prevHead = o.t;
      lastClickT = isClick ? o.t : null;
    }
  }
  return out;
}

/** 行の表示用: 重複除去・畳みの前後の数を短く残す（後から検証できる形） */
export function pressStatNote(label: string, s: PressGapStat | undefined): string {
  if (!s) return `${label}元0→重複除去0→1押下0`;
  return `${label}元${s.rawOps}→重複除去${s.uniqueOps}→1押下${s.presses}`;
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
