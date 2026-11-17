/**
 * 写真学習（photo_learn）の枚数の決まり（純関数・DBなし）
 *
 * ★ 2026-11-16 竹内さん「上限20枚ではなくて必要なら解決するまで読み取る」
 *   「課題を解決することが優先」「そこの部分は統括が判断する」:
 *   ・旧: 常に上限20（費用の歯止めを固定）
 *   ・新: **統括が課題（未読枚数・弱い欄）を見て枚数を決める**
 *     課題が残っているうちは必要なだけ読む。止めは**硬上限**だけ（暴走防止）。
 */

/**
 * ★ 2026-11-16 竹内さん「画像よむのはflashでまとめるのは統括（Pro）」:
 *   画像読み（Vision）の既定は **deepseek-flash だけ**。Pro は統括まとめ層（learn-supervisor-pro）。
 *   混ぜない（Pro を Vision に使うと no_fields が多い実測あり）。
 */
export const SHOT_LEARN_DEFAULT_MODEL = "deepseek-flash";

/** 画像読みのモデル: SHOT_LEARN_MODEL → flash（DEEPSEEK_MODEL=Pro でも Vision は flash） */
export function shotLearnModel(env: Record<string, string | undefined> = process.env): string {
  const explicit = (env.SHOT_LEARN_MODEL ?? "").trim();
  if (explicit) return explicit;
  return SHOT_LEARN_DEFAULT_MODEL;
}

/** 1回の実行で絶対に超えない枚数（費用の暴走防止・統括でも超えられない） */
export const SHOT_LEARN_HARD_CAP = 500;

/** 呼ぶ側が limit を付けない時の既定（課題が無い・統括が枚数を出していない） */
export const SHOT_LEARN_DEFAULT = 20;

export function shotLearnHardCap(): number {
  return SHOT_LEARN_HARD_CAP;
}

/** 環境変数 SHOT_LEARN_MAX があればそれ（硬上限まで）。無ければ既定 */
export function shotLearnMax(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.SHOT_LEARN_MAX);
  if (Number.isFinite(v) && v > 0) return Math.min(SHOT_LEARN_HARD_CAP, Math.floor(v));
  return SHOT_LEARN_DEFAULT;
}

/**
 * 統括が photo_learn の枚数を決める。
 *   ・explicit … 統括・人が明示した枚数（最優先）
 *   ・todo     … 読める未学習の枚数（課題があるならこれを上限に近づける）
 *   ・fieldCount … 弱い欄の数（未読数が取れない時の目安）
 */
export function photoLearnLimitFor(opt: {
  todo?: number | null;
  fieldCount?: number | null;
  explicit?: number | null;
} = {}): number {
  const hard = SHOT_LEARN_HARD_CAP;
  if (opt.explicit != null && Number.isFinite(Number(opt.explicit)) && Number(opt.explicit) > 0) {
    return Math.min(hard, Math.max(1, Math.floor(Number(opt.explicit))));
  }
  const todo = Math.max(0, Math.floor(Number(opt.todo) || 0));
  if (todo > 0) return Math.min(hard, todo);
  const fields = Math.max(0, Math.floor(Number(opt.fieldCount) || 0));
  if (fields > 0) return Math.min(hard, Math.max(SHOT_LEARN_DEFAULT, fields * 10));
  return Math.min(hard, SHOT_LEARN_DEFAULT);
}

/** 実行時に実際に読む枚数（明示 limit と硬上限・既定の合成） */
export function resolveShotLearnLimit(optLimit?: number | null, env?: Record<string, string | undefined>): number {
  const hard = SHOT_LEARN_HARD_CAP;
  if (optLimit != null && Number.isFinite(Number(optLimit)) && Number(optLimit) > 0) {
    return Math.min(hard, Math.max(1, Math.floor(Number(optLimit))));
  }
  return Math.min(hard, shotLearnMax(env));
}
