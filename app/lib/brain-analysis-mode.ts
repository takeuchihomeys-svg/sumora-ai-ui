// app/lib/brain-analysis-mode.ts
// ブレインの3段階モード判定（full / incremental / cached）の純関数。brain-core analyzeAndSaveBrainMeta から呼ぶ。
// 依存は aix-scene-evidence だけ（supabase を読み込まないので単体テストできる）。
import { detectAixSceneEvidence } from "./aix-scene-evidence";

// 分析モードの3段階（2026-09-13 実態に合わせて説明を更新。旧「10メッセージに1回のフル分析・それ以外はキャッシュ」は段1以前の設計）:
//   full（前回の判断を使わずゼロから）: 初回〜10件 / 申込・契約・審査・キャンセル語 / 前回の分析か最新発言から24時間 / 全体分析から30件
//   incremental（前回の判断を起点に、直近15件・RAG・台帳は full と同じ）: 条件・URL・画像・見送り等 / 前回の分析から10件 /
//     新しいお客様発言に場面の証拠がある・前回の action がある（段1の格上げ）
//   cached（LLM なし・前回の判断を AIX なしで使い回す）: 新しいお客様の発言が無い時だけ（2026-09-14 から。新しい発言は必ず分析）
// FULL_ANALYSIS_EVERY_N_MESSAGES は名前に反して「前回の分析（full/incremental）から10件で incremental に上げる」閾値
export const FULL_ANALYSIS_EVERY_N_MESSAGES = 10;
export const FULL_REFRESH_EVERY_N_MESSAGES = 30;  // フル分析から30件で強制フルリフレッシュ（アンカリング防止）

/** 前回の分析から何も届いていない時に、保存済みの判断をそのまま使う時間（これより古ければ時間の経過を踏まえて分析し直す） */
export const UNCHANGED_REUSE_HOURS = 6;

export type UnchangedInput = {
  /** 今の会話のメッセージ総数（お客様・スタッフ・AIX 全部） */
  totalMsgCount: number;
  /** 前回の実分析（full/incremental）の時のメッセージ総数（brain_full_msg_count） */
  lastAnalyzedMsgCount: number | null;
  /** 前回の実分析の時刻（brain_full_analyzed_at） */
  lastAnalyzedAt: string | null;
  /** 保存済みの判断（suggested_aix_meta）があるか */
  hasSuggestedMeta: boolean;
  /** 保存済みの判断が最新のお客様の発言を見ているか（brainMissedCustomerMessage の否定） */
  suggestedSawLatestCustomer: boolean;
  /** 未返信の連投に画像がある（読み取りが後から入る＝中身が変わりうる） */
  latestTurnHasImage: boolean;
  /** スタッフの宣言直後・画像の読み取り完了など、呼び出し側が分析し直しを求めている */
  forced: boolean;
  nowMs: number;
};

/**
 * 2026-09-14 竹内（API の漏れ調査）: 前回の分析から会話に何も届いていない（メッセージ総数が同じ）なら、分析も書き込みもしない。
 *   旧: 新しい発言が無くても、会話が10件以下・申込等の語・URL・画像・24時間経過のどれかで full/incremental になり、
 *   AIX 誘導中の会話を開くたび（bg-async）に同じ発言を分析し直していた（9/14: 分析87件中12件が前回と同じ発言。34秒〜88分後）。
 *   同じ入力への再分析は判断のくじ引きで（設計知見「分析強化の原則」③）、費用だけ増える。
 *   cached（AIX を空にする省略）にしないのは、保存済みの判断は今回の発言を見た新しい判断だから（空にすると開くたびに AIX が消える）。
 */
export function nothingNewSinceLastAnalysis(i: UnchangedInput): boolean {
  if (i.forced || i.latestTurnHasImage) return false;
  if (!i.hasSuggestedMeta || !i.suggestedSawLatestCustomer) return false;
  if (i.lastAnalyzedMsgCount == null || i.lastAnalyzedMsgCount <= 0 || !i.lastAnalyzedAt) return false;
  if (i.totalMsgCount !== i.lastAnalyzedMsgCount) return false;
  const at = Date.parse(i.lastAnalyzedAt);
  if (!Number.isFinite(at)) return false;
  return i.nowMs - at < UNCHANGED_REUSE_HOURS * 60 * 60 * 1000;
}

// ── 二重起動の合流（2026-09-18 竹内「重複だけ直す」）────────────────────────────
// 実測（brain_decision_logs・直近7日608回）: 同じ analyzed_msg_ts の再分析が133回（22%）で、
//   1分以内 30回／5分以内 44回／30分以内 72回／30分超 61回。
// 30分超は「スタッフが送信した後の再分析」（feedback_sent_content_every_analysis の仕様）なので触らない。
// 直すのは**数十秒以内の再分析**＝同じ出来事で複数の入口（line-webhook / generate-draft-bg-async /
//   send-line-message / brain-sweep）が同時に走った競合。
// nothingNewSinceLastAnalysis は「前回が**完了していれば**」効くが、同時に走ると両方とも
//   「前回の分析時点」を見るのでどちらも素通りする（レースコンディション）。

/** これより短い間隔での再実行は同じ出来事の二重起動とみなす */
export const DUPLICATE_RUN_WINDOW_MS = 45_000;

export type DuplicateRunInput = {
  /** 直近の分析の打刻（conversations.brain_analyzed_at。成功・スキップとも打つ） */
  brainAnalyzedAt: string | null;
  /** 呼び出し側が分析し直しを求めている（スタッフの宣言送信直後・画像の読み取り完了） */
  forced: boolean;
  /** 保存済みの判断があるか（無ければ省略しない＝初回は必ず分析する） */
  hasSuggestedMeta: boolean;
  nowMs: number;
};

/**
 * 同じ出来事の二重起動か（＝直近 DUPLICATE_RUN_WINDOW_MS 以内に分析が走っている）。
 * ・forced（スタッフの宣言直後など）は必ず走らせる
 * ・保存済みの判断が無ければ走らせる（初回・失敗直後を止めない）
 * ・時刻が読めない時は走らせる（fail-open）
 */
export function isDuplicateRun(i: DuplicateRunInput): boolean {
  if (i.forced || !i.hasSuggestedMeta || !i.brainAnalyzedAt) return false;
  const at = Date.parse(i.brainAnalyzedAt);
  if (!Number.isFinite(at)) return false;
  const elapsed = i.nowMs - at;
  return elapsed >= 0 && elapsed < DUPLICATE_RUN_WINDOW_MS;
}

export type AnalysisModeInput = {
  hasCachedMeta: boolean;
  totalMsgCount: number;
  isFullBypass: boolean;
  isIncrementalBypass: boolean;
  hoursSinceLastFull: number;
  hoursSinceLastMsg: number;
  msgsSinceDeep: number;
  msgsSinceLastFull: number;
  /** 最新の顧客発言（分析モードの格上げ判定用）。brain-core は未返信の顧客の連投全体（URL→「こちらです！」の分割送信を1まとまり）を渡す */
  latestCustomerText: string;
  /** 未返信の連投に画像があるか（連投全体を渡す時は先頭行の [画像] では判定できないため別に渡す） */
  latestTurnHasImage?: boolean;
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
      hasCustomerImage: i.latestTurnHasImage ?? /^\[画像\]/.test(i.latestCustomerText),
      sentPropertyCount: i.sentPropertyCount,
    });
    if (evidence) return { mode: "incremental", upgradeReason: `scene_evidence:${evidence.scene}` };
    if ((i.prevAction ?? "").trim()) return { mode: "incremental", upgradeReason: `prev_action:${i.prevAction}` };
    // 2026-09-14 竹内（名無しの権兵衛事例）「送った内容や AIX ボタンのどこを送ったか等は鮮度の高い部分なので毎回の分析に入る」:
    //   新しいお客様の発言は必ず分析する（今回の発言の層は軽い＝2層ブレイン）。旧: 場面の証拠が無く前回の action が空だと cached（分析なし）で、
    //   内覧当日の「少し遅れます」「着きました！」・「駐車場必要情報は同居人の方がよろしいでしょうか」に判断が無いまま下書きが作られた（24時間で3回・全て T3）
    return { mode: "incremental", upgradeReason: "unseen_customer_msg" };
  }
  // cached は新しいお客様の発言が無い再実行（スタッフの送信直後の起動など）の時だけ
  return { mode: "cached", upgradeReason: null };
}
