/**
 * 会話ステータス定数の単一ソース（single source of truth）
 * 以前は8ファイルで独立定義され値が食い違っていた問題を解消（2026-09-02）
 *
 * 値の正は brain-core.ts / bg-async 系で運用されていた実値に統一：
 * - BRAIN_SKIP_STATUSES: applying/screening を含めない（全成約が通過する
 *   申込フェーズのため brain 分析対象。平均42日・169件の学習例あり）
 * - DRAFT_SKIP_STATUSES: bg-async / line-webhook / generate-reply /
 *   analyze-diffs で使われていた8値セット。generate-pending-drafts
 *   （lost/approved 欠落）と generate-draft-bg（4値のみ）の欠落バグを修正
 */

/**
 * Brain分析をスキップするステータス（成約・終了・承認済み会話）
 * 配列である理由: brain/list・cron/brain-sweep が Supabase の
 * `not.in.(${...join(",")})` フィルタ構築に使うため（Set不可）
 */
export const BRAIN_SKIP_STATUSES: string[] = [
  "contract",
  "closed_won",
  "closed_lost",
  "lost",
  "approved",
];

/** ドラフト自動生成をスキップするステータス（申込フェーズ以降すべて） */
export const DRAFT_SKIP_STATUSES = new Set([
  "applying",
  "application",
  "screening",
  "contract",
  "closed_won",
  "closed_lost",
  "lost",
  "approved",
]);

/** bg-async / line-webhook がスキップするステータス（DRAFT_SKIP_STATUSESと同値） */
export const BG_ASYNC_SKIP_STATUSES = DRAFT_SKIP_STATUSES;

/**
 * AIX誘導タスク（line_tasks.task_type）のうち、進行中ならドラフト自動生成を
 * スキップするもの（property_check は短い返しを生成するため含めない）
 */
export const AIX_SKIP_TYPES = new Set(["property_send", "estimate_sheet"]);
