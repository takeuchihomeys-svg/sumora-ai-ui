// 自動モードのマウスの「動き計画」（motion_plan）を作る純関数。
//
// 2026-11-19 竹内さん「動き方もAPIで決めていたら良いのでは」「APIこっちからも作れるようにするのが理想」
//   → 拡張 2.8.125 の受け口（window.__axlxMotionPlan = chrome.storage axlx_motion_plan）に合わせた形を返す。
//   形: { v:1, plan_id, expires_at(ISO), run_seed, persona:{ speed_scale, curve_gain, overshoot_p, hesitate_p, press_ms, tremor, dwell_scale } }
//
// ⚠ 範囲は `chrome-extension/human-wait.js` の PERSONA_RANGE と同じ（拡張側でも範囲に丸める＝二重の守り）。
//   範囲を変える時は両方を揃える（tests/motion-plan.test.ts が拡張の sanitizePlan を通して食い違いを見張る）。
// ⚠ DB は読まない・書かない（軽い・営業時間でも安全）。人の実測分布への寄せ方は拡張側の planMove が持つ。
//   サーバーが決めるのは「このラン（検索）の個性」と「期限」だけ。次の段（統括が motion_stats を見て中心を動かす）はここに足す。

export const PERSONA_RANGE = {
  speed_scale: [0.6, 1.7],
  curve_gain: [0.4, 1.5],
  overshoot_p: [0.08, 0.28],
  hesitate_p: [0.1, 0.3],
  press_ms: [60, 120],
  tremor: [0.4, 1.6],
  dwell_scale: [0.6, 1.6],
} as const;

export type PersonaKey = keyof typeof PERSONA_RANGE;

export type MotionPlan = {
  v: 1;
  plan_id: string;
  expires_at: string;
  run_seed: number;
  persona: Record<PersonaKey, number>;
};

export type MotionPlanOpts = {
  /** 0〜1 の乱数（テストで固定する用）。無ければ Math.random */
  rng?: () => number;
  /** 現在時刻 ms（テスト用） */
  now?: number;
  /** 有効期間 ms（既定 10分）。ラン開始の直前に取り直す前提なので短くてよい */
  ttlMs?: number;
};

function clamp(key: PersonaKey, v: number): number {
  const [lo, hi] = PERSONA_RANGE[key];
  return Math.max(lo, Math.min(hi, v));
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** 標準正規分布（Box-Muller） */
function gauss(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function buildMotionPlan(opts: MotionPlanOpts = {}): MotionPlan {
  const rng = opts.rng ?? Math.random;
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const ttl = typeof opts.ttlMs === "number" && opts.ttlMs > 0 ? opts.ttlMs : 10 * 60 * 1000;
  const runSeed = Math.floor(rng() * 4294967296) >>> 0;
  const persona: Record<PersonaKey, number> = {
    // 速さ・曲がり・一息の長さは中心 1.0 の対数正規（人の実測の中央値を基準にした倍率）
    speed_scale: round3(clamp("speed_scale", Math.exp(0.25 * gauss(rng)))),
    curve_gain: round3(clamp("curve_gain", Math.exp(0.25 * gauss(rng)))),
    overshoot_p: round3(clamp("overshoot_p", 0.08 + 0.2 * rng())),
    hesitate_p: round3(clamp("hesitate_p", 0.1 + 0.2 * rng())),
    press_ms: round3(clamp("press_ms", 60 + 60 * rng())),
    tremor: round3(clamp("tremor", 0.4 + 1.2 * rng())),
    dwell_scale: round3(clamp("dwell_scale", Math.exp(0.25 * gauss(rng)))),
  };
  return {
    v: 1,
    plan_id: "mp-" + now.toString(36) + "-" + runSeed.toString(36),
    expires_at: new Date(now + ttl).toISOString(),
    run_seed: runSeed,
    persona,
  };
}
