/**
 * 学習・統括が使う期間の正本（2026-11-16）
 *
 * ★ 竹内さん「学習期間もちゃんとそろえておく／Proの部分ちゃんとすべて把握できるように」:
 *   旧は動き3日・監査24時間・指示7日・履歴30日とバラバラで、
 *   統括Proが「実際の検索」と「動きの材料」を別窓で見ていた。
 *   → **学習材料は同じ窓**に揃える。指示の見張り・長期履歴だけ別枠。
 *
 * ⚠ ここを変えたら human-learn-profile / summarizeAudits / commands も同じ定数を使う。
 */

/** 1日（ms） */
export const DAY_MS = 86_400_000;

export const LEARN_PERIODS = {
  /**
   * 学習材料の主期間（人間の動き・写真・実際の検索の監査を揃える）
   * → 統括Proが同じ窓の数字で判断する
   */
  materialsMs: 3 * DAY_MS,
  /** 指示（automation_commands）の見張り */
  commandsMs: 7 * DAY_MS,
  /** 束・ログの長期参照 */
  historyMs: 30 * DAY_MS,
  /** 束の鮮度（これより古い束は作り直す） */
  bundleFreshMs: 30 * 60 * 1000,
} as const;

export type LearnPeriodKey = keyof typeof LEARN_PERIODS;

/** ISO 文字列（いま − ms） */
export function sinceIso(ms: number, now = Date.now()): string {
  return new Date(now - ms).toISOString();
}

/** 人が読める期間ラベル */
export function periodLabelJa(ms: number): string {
  if (ms >= DAY_MS && ms % DAY_MS === 0) return `${ms / DAY_MS}日`;
  if (ms >= 3600_000 && ms % 3600_000 === 0) return `${ms / 3600_000}時間`;
  return `${Math.round(ms / 60_000)}分`;
}
