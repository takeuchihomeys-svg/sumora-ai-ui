// app/lib/brain-analysis-mode.ts
// ブレインの3段階モード判定（full / incremental / cached）の純関数。brain-core analyzeAndSaveBrainMeta から呼ぶ。
// 依存は aix-scene-evidence だけ（supabase を読み込まないので単体テストできる）。
import { detectAixSceneEvidence } from "./aix-scene-evidence";

// フル分析スキップ判定: 10メッセージに1回のフル分析（それ以外はキャッシュ返却）
export const FULL_ANALYSIS_EVERY_N_MESSAGES = 10;
export const FULL_REFRESH_EVERY_N_MESSAGES = 30;  // フル分析から30件で強制フルリフレッシュ（アンカリング防止）

export type AnalysisModeInput = {
  hasCachedMeta: boolean;
  totalMsgCount: number;
  isFullBypass: boolean;
  isIncrementalBypass: boolean;
  hoursSinceLastFull: number;
  hoursSinceLastMsg: number;
  msgsSinceDeep: number;
  msgsSinceLastFull: number;
  /** 最新の顧客発言（分析モードの格上げ判定用） */
  latestCustomerText: string;
  latestCustomerMsgAt: string | null;
  /** 前回の実分析（last_brain_meta）が見た最新顧客発言の時刻 */
  prevAnalyzedMsgTs: string | null;
  /** 前回の実分析の action */
  prevAction: string | null;
  sentPropertyCount: number;
};

/**
 * 2026-09-12 竹内方針「AIX のセットはブレインが判断する」段1: 古い判断が生まれる元をなくす。
 *   今回の顧客発言が前回の分析より新しく、かつ
 *     (1) 決定論の場面の証拠が当たる（空室・入居日・審査・内覧・日時指定・条件変更 等）
 *     (2) 前回の action が空でない（前の AIX 判断を今回の発言で見直す必要がある）
 *   のどちらかなら cached ではなく incremental に上げる（upgradeReason をログに出して LLM 呼び出しの増加を測る）。
 */
export function decideAnalysisMode(i: AnalysisModeInput): { mode: "full" | "incremental" | "cached"; upgradeReason: string | null } {
  const needsFull =
    !i.hasCachedMeta ||
    i.totalMsgCount < 11 ||
    i.isFullBypass ||                                              // 申込/契約/審査/キャンセルは必ずfull
    i.hoursSinceLastFull >= 24 ||
    i.hoursSinceLastMsg >= 24 ||
    i.msgsSinceDeep >= FULL_REFRESH_EVERY_N_MESSAGES;
  if (needsFull) return { mode: "full", upgradeReason: null };
  if (i.isIncrementalBypass || i.msgsSinceLastFull >= FULL_ANALYSIS_EVERY_N_MESSAGES) return { mode: "incremental", upgradeReason: null };

  const latestMs = i.latestCustomerMsgAt ? new Date(i.latestCustomerMsgAt).getTime() : NaN;
  const prevMs = i.prevAnalyzedMsgTs ? new Date(i.prevAnalyzedMsgTs).getTime() : NaN;
  // 前回の分析が今回の顧客発言を見ていない（前回の時刻が無い＝古くない証拠が無いので見直す側に倒す）
  const hasUnseenCustomerMsg = !Number.isNaN(latestMs) && (Number.isNaN(prevMs) || latestMs > prevMs);
  if (hasUnseenCustomerMsg) {
    const evidence = detectAixSceneEvidence({
      latestCustomerTurn: i.latestCustomerText,
      hasCustomerImage: /^\[画像\]/.test(i.latestCustomerText),
      sentPropertyCount: i.sentPropertyCount,
    });
    if (evidence) return { mode: "incremental", upgradeReason: `scene_evidence:${evidence.scene}` };
    if ((i.prevAction ?? "").trim()) return { mode: "incremental", upgradeReason: `prev_action:${i.prevAction}` };
  }
  return { mode: "cached", upgradeReason: null };
}
