/**
 * 人間らしさ未達（近さ・短間隔・human帯・押した位置）の改善周回（純関数）
 *
 *   竹内さん「未達の部分改善するために改善する仕組みつくる／画像学習から改善しても大丈夫／費用かかっても大丈夫」
 *   統括Pro: ①間隔寄せ（無料・拡張）→②photo_learn（位置）→③再読込→自動→再測
 *
 * 完了線:
 *   近さ≥70・短間隔≤12%・human帯≥50%・押した位置≥60%（DETAIL_DEGREE.POINT_OK）
 *
 * 仕組み（F59）:
 *   測る → 計画 → 束に人の間隔を書く（gaps）→ 位置は photo_learn → 反映 → 拡張再読込 → 自動 → 再測
 *   未達が残れば同じ周回。費用 OK なら Vision を止めない（硬上限まで統括が枚数を決める）。
 */
import { NEARNESS_ALLOW, bucketGaps } from "./human-nearness";
import { DETAIL_DEGREE } from "./learn-improve-mech";
import { photoLearnLimitFor } from "./shot-learn-limit";
import type { ImproveTask } from "./improve-loop";

export type HumanLikeMetrics = {
  nearnessScore: number | null;
  fast400pct: number | null;
  humanBandPct: number | null;
  pointPct: number | null;
  cursorPct: number | null;
  /** 通常未学習枚数（photo_learn 枚数の材料） */
  unreadNormal?: number | null;
  /** 位置が薄い欄名 */
  thinPointFields?: string[];
};

export type HumanLikeImprovePhase =
  | "ok"
  | "need_ext_spacing"
  | "photo_learn_point"
  | "need_reload_auto"
  | "remeasure";

export type HumanLikeImprovePlan = {
  at: string;
  ok: boolean;
  phase: HumanLikeImprovePhase;
  gaps: string[];
  line: string;
  /** 実行順（photo_learn / need_ext_reload / need_auto_run / verify） */
  cycle: ImproveTask[];
  /** 統括が決めた photo_learn 枚数（合計目安） */
  photo_limit: number;
  allow: {
    nearnessMin: number;
    fast400Max: number;
    humanBandMin: number;
    pointMin: number;
    cursorMin: number;
  };
  metrics: HumanLikeMetrics;
};

/** 位置の完了線は DETAIL_DEGREE と同じ */
export const HUMAN_LIKE_IMPROVE_ALLOW = {
  nearnessMin: NEARNESS_ALLOW.scoreMin,
  fast400Max: NEARNESS_ALLOW.fast400MaxPct,
  humanBandMin: NEARNESS_ALLOW.humanBandMinPct,
  pointMin: DETAIL_DEGREE.POINT_OK,
  cursorMin: DETAIL_DEGREE.CURSOR_OK,
} as const;

/** 位置学習の既定フォーカス（realpro・束で薄く出やすい欄） */
export const HUMAN_LIKE_POINT_FOCUS_DEFAULT: ReadonlyArray<string> = [
  "rental_cost1",
  "rental_cost2",
  "update_date",
  "structured_date",
  "city_code[]",
  "確定してリストへ",
  "所在地絞り込み＋",
  "検索",
];

/** 束／拡張へ渡す「人の押す間隔」（axlx_learn_gaps と同じ形＋改善用の床） */
export type HumanGapPace = {
  median_ms: number;
  samples: number;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  fast400pct: number | null;
  humanBandPct: number | null;
  /** 拡張の硬下限寄せ（通常 p10 と 900 の大きい方・上限 1800） */
  floor_ms: number;
  at: string;
};

/** 通常の動作間隔から、拡張が読む人の間隔を作る（純関数） */
export function learnGapPaceFromNormalGaps(
  normalGaps: ReadonlyArray<number>,
  nowMs: number = Date.now(),
): HumanGapPace | null {
  const gs = normalGaps.filter((n) => Number.isFinite(n) && n >= 0);
  if (gs.length < 10) return null;
  const b = bucketGaps([...gs]);
  const median = b.p50 ?? 0;
  if (!(median > 0)) return null;
  const p10 = b.p10;
  const floor = Math.max(900, Math.min(1800, Math.round((p10 && p10 > 0 ? p10 : median * 0.5))));
  /**
   * 拡張が読む中央値は human帯（700〜2000）の中心へ寄せる。
   * 畳み中央が帯外（実測≈2525）のままだと _wardGapPlan の fast も帯外になり human帯%が上がらない。
   */
  const extMedian =
    median > 2000 ? 1400 : median < 700 ? 1100 : Math.max(1000, Math.min(1700, Math.round(median)));
  return {
    median_ms: extMedian,
    samples: b.gN,
    p10: b.p10,
    p50: b.p50,
    p90: b.p90,
    fast400pct: b.fast400pct,
    humanBandPct: b.humanBandPct,
    floor_ms: floor,
    at: new Date(nowMs).toISOString(),
  };
}

export const HUMAN_LIKE_IMPROVE_STAMP_REL = "memory/human_like_improve_last.json";

/**
 * 改善計画に使う近さの数字を選ぶ（純関数）。
 *
 *   ⚠ gapsFromOps 正本は「1押下＝2〜3本 click」＋写真窓の重ねで短間隔が跳ねる。
 *     pressGaps（1押下畳み）の方が完了線の意図に合う。畳みの自動 n≥20 なら畳みを主にする。
 */
export function pickNearnessForImprove(
  raw: { score?: number | null; fast?: number | null; hb?: number | null; gN?: number | null },
  fold: { score?: number | null; fast?: number | null; hb?: number | null; gN?: number | null },
): {
  source: "fold" | "raw";
  nearnessScore: number | null;
  fast400pct: number | null;
  humanBandPct: number | null;
} {
  const foldN = Number(fold.gN) || 0;
  if (foldN >= 20) {
    return {
      source: "fold",
      nearnessScore: fold.score ?? null,
      fast400pct: fold.fast ?? null,
      humanBandPct: fold.hb ?? null,
    };
  }
  return {
    source: "raw",
    nearnessScore: raw.score ?? null,
    fast400pct: raw.fast ?? null,
    humanBandPct: raw.hb ?? null,
  };
}

/**
 * 押した位置%は「直近自動の point_fields」を優先（束 human_like は過去通常の監査で、photo_learn 後も動かない）。
 */
export function pickPointPctForImprove(
  autoPointPct: number | null | undefined,
  bundlePointPct: number | null | undefined,
  autoRows: number | null | undefined = null,
): { source: "auto" | "bundle"; pointPct: number | null } {
  if (autoPointPct != null && (autoRows == null || autoRows >= 3)) {
    return { source: "auto", pointPct: autoPointPct };
  }
  return { source: "bundle", pointPct: bundlePointPct ?? null };
}

/** スタンプから完了線を判定（F58 と同じ型の周回） */
export function evaluateHumanLikeImproveStamp(stamp: {
  nearness_raw?: { score?: number | null; fast?: number | null; hb?: number | null; allowed?: boolean; gN?: number | null };
  nearness_fold?: { score?: number | null; fast?: number | null; hb?: number | null; allowed?: boolean; gN?: number | null };
  point_pct?: number | null;
  cursor_pct?: number | null;
  /** 測り方の注記（fold / raw）— 無い時は fold があれば fold */
  nearness_source?: "fold" | "raw";
}): { ok: boolean; gaps: string[]; line: string; next: string } {
  const picked = pickNearnessForImprove(
    {
      score: stamp.nearness_raw?.score,
      fast: stamp.nearness_raw?.fast,
      hb: stamp.nearness_raw?.hb,
      gN: stamp.nearness_raw?.gN,
    },
    {
      score: stamp.nearness_fold?.score,
      fast: stamp.nearness_fold?.fast,
      hb: stamp.nearness_fold?.hb,
      gN: stamp.nearness_fold?.gN ?? (stamp.nearness_fold?.score != null ? 20 : 0),
    },
  );
  const plan = buildHumanLikeImprovePlan({
    nearnessScore: picked.nearnessScore,
    fast400pct: picked.fast400pct,
    humanBandPct: picked.humanBandPct,
    pointPct: stamp.point_pct ?? null,
    cursorPct: stamp.cursor_pct ?? null,
  });
  return {
    ok: plan.ok,
    gaps: plan.gaps,
    line: plan.line,
    next: plan.ok
      ? "完了線クリア。鮮度を保つため週次で --plan-only 再測"
      : `次: ${plan.cycle[0]?.kind ?? "-"}（${plan.cycle[0]?.what ?? "再測"}）→ scripts/human-like-improve.ts --yes-cost`,
  };
}

export function buildHumanLikeImprovePlan(
  m: HumanLikeMetrics,
  nowMs: number = Date.now(),
): HumanLikeImprovePlan {
  const allow = { ...HUMAN_LIKE_IMPROVE_ALLOW };
  const gaps: string[] = [];
  if (m.nearnessScore != null && m.nearnessScore < allow.nearnessMin) {
    gaps.push(`近さ${m.nearnessScore}<${allow.nearnessMin}`);
  }
  if (m.fast400pct != null && m.fast400pct > allow.fast400Max) {
    gaps.push(`短間隔${m.fast400pct}%>${allow.fast400Max}%`);
  }
  if (m.humanBandPct != null && m.humanBandPct < allow.humanBandMin) {
    gaps.push(`human帯${m.humanBandPct}%<${allow.humanBandMin}%`);
  }
  if (m.pointPct != null && m.pointPct < allow.pointMin) {
    gaps.push(`押した位置${m.pointPct}%<${allow.pointMin}%`);
  }
  if (m.cursorPct != null && m.cursorPct < allow.cursorMin) {
    gaps.push(`カーソル${m.cursorPct}%<${allow.cursorMin}%`);
  }

  const needSpacing =
    (m.fast400pct != null && m.fast400pct > allow.fast400Max) ||
    (m.humanBandPct != null && m.humanBandPct < allow.humanBandMin) ||
    (m.nearnessScore != null && m.nearnessScore < allow.nearnessMin);
  const needPoint = m.pointPct != null && m.pointPct < allow.pointMin;

  /** thin でも pager／次ページ系は位置学習の焦点にしない（狙っても押し方に効きにくい） */
  const thinUseful = (m.thinPointFields || []).filter(
    (f) => !/^(次|pager|次へ|最初前|area_b$)/i.test(String(f)) && !/pager_box|次のページ/.test(String(f)),
  );
  const focus = [
    ...thinUseful,
    ...HUMAN_LIKE_POINT_FOCUS_DEFAULT.filter((d) => !thinUseful.includes(d)),
  ].slice(0, 8);

  const photo_limit = photoLearnLimitFor({
    todo: m.unreadNormal ?? null,
    fieldCount: needPoint ? Math.max(focus.length, 3) : 0,
    // 位置未達の初周: 欄×10 か未読。硬上限内。課題が無ければ既定。
    explicit: needPoint
      ? Math.min(
          120,
          Math.max(24, (m.unreadNormal && m.unreadNormal > 0 ? Math.min(80, m.unreadNormal) : focus.length * 10)),
        )
      : null,
  });

  const cycle: ImproveTask[] = [];
  if (needSpacing) {
    cycle.push({
      kind: "reflect_auto",
      what: "通常の動作間隔から人の中央値を束 gaps に書く（axlx_learn_gaps・floor_ms）",
      why: `短間隔・human帯・近さが未達（${gaps.filter((g) => /短間隔|human帯|近さ/.test(g)).join("／") || "間隔系"}）。拡張が束の人の間隔でレーン待ちを寄せる`,
      cost: "無料",
    });
    cycle.push({
      kind: "need_ext_reload",
      what: "拡張再読込→束取得（間隔寄せ _wardGapPlan/_selGapPlan・束 gaps・硬下限）",
      why: "新しい gaps.median_ms / floor_ms を __axlxLearnGapMs に載せる",
      cost: "無料",
    });
    cycle.push({
      kind: "need_auto_run",
      what: "自動1回（間隔寄せの効果を本番印で残す）",
      why: "再読込だけでは短間隔%は下がらない。自動1回のあと正本 gapsFromOps / pressGaps で再測",
      cost: "無料",
    });
  }
  if (needPoint) {
    cycle.push({
      kind: "photo_learn",
      what: `位置観点の photo_learn（thin n≥1 を束へ・対象 ${focus.slice(0, 4).join("・")}）`,
      why: `押した位置${m.pointPct}%（要≥${allow.pointMin}%）。flash→束 aim→拡張が狙う`,
      cost: "有料（Vision）",
      limit: photo_limit,
      order: "newest",
      fields: focus,
    });
    // 間隔も未達なら連続画像でフォーム操作の流れも補強（費用 OK・統括が枚数）
    if (needSpacing) {
      const seqLimit = Math.min(40, Math.max(12, Math.floor(photo_limit / 3)));
      cycle.push({
        kind: "photo_learn",
        what: "連続画像 photo_learn（form/cond の流れ・間隔の場面理解）",
        why: "短間隔未達の補助。ラン全体を読んで押しの区切りを束に載せる",
        cost: "有料（Vision）",
        limit: seqLimit,
        order: "sequence",
        fields: focus.slice(0, 4),
      });
    }
    cycle.push({
      kind: "reflect_auto",
      what: "束に位置・gaps・human_nearness を載せて反映（thin も落とさない）",
      why: "読んだだけでは aim に届かない。近さの数字も束に残して統括が追える",
      cost: "無料",
    });
    cycle.push({
      kind: "need_ext_reload",
      what: "拡張再読込→束再取得（aim 有の位置）",
      why: "新しい points / learned / gaps を拡張が読む",
      cost: "無料",
    });
    cycle.push({
      kind: "need_auto_run",
      what: "自動1回（aim有・rec-point・point_pct・間隔印を測る）",
      why: "F55 aim有=0 の穴を埋める。人間らしさ完了線は自動1回後の再測で決める",
      cost: "無料",
    });
  }
  if (gaps.length) {
    cycle.push({
      kind: "verify_improve",
      what: "正本で再測（近さ・短間隔・human帯・押した位置）",
      why: "完了線まで周回。未達が残ればまた photo_learn / 間隔寄せ",
      cost: "無料",
    });
  }

  let phase: HumanLikeImprovePhase = "ok";
  if (needSpacing) phase = "need_ext_spacing";
  else if (needPoint) phase = "photo_learn_point";
  else if (gaps.length) phase = "remeasure";

  const ok = gaps.length === 0;
  const line = ok
    ? `人間らしさ改善完了 近さ${m.nearnessScore ?? "-"}・短間隔${m.fast400pct ?? "-"}%・human帯${m.humanBandPct ?? "-"}%・位置${m.pointPct ?? "-"}%`
    : `人間らしさ改善 止=${phase} 未達=${gaps.join("／")} 次=${cycle[0]?.kind ?? "-"} photo上限=${needPoint ? photo_limit : 0}`;

  return {
    at: new Date(nowMs).toISOString(),
    ok,
    phase,
    gaps,
    line,
    cycle,
    photo_limit: needPoint ? photo_limit : 0,
    allow,
    metrics: m,
  };
}
