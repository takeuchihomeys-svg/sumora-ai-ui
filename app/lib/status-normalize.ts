/**
 * conversation_status の正規化モジュール
 *
 * 旧ステート名（DBに保存された旧値）を新5段階ステータスへ変換する。
 * suggest-status-update / suggest-next-action / learn-action-patterns の
 * 3ルートで共通使用し、パターン統計が旧名・新名で分散するのを防ぐ。
 */

export const STATUS_ALIAS: Record<string, string> = {
  first_reply:              "hearing",
  condition_hearing:        "hearing",
  property_search:          "hearing",
  property_recommendation:  "proposing",
  viewing:                  "proposing",
  estimate_request:         "proposing",
  availability_check:       "proposing",
  application:              "applying",
  screening:                "applying",
  contract:                 "applying",
};

/**
 * 旧ステータス名を新5段階ステータスへ正規化する。
 * マッピングに存在しない値はそのまま返す。
 */
export function normalizeStatus(status: string): string {
  return STATUS_ALIAS[status] ?? status;
}
