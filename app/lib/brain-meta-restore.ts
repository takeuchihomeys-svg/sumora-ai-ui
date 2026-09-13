// app/lib/brain-meta-restore.ts
// 下書きを画面に表示した後の生成（再生成・✨・AIX 文面）に、ブレインの判断を届けるための復元判定（純関数・依存なし）。
//
// 2026-09-13 監査: 画面は下書きを表示した時点で conversations.suggested_aix_meta を null にする（page.tsx の __SHOWN__ 化。
//   表示と判断を1組の「使い切り」として扱う古い設計で、バナー等の表示ロジックがこれを前提にしている）。
//   一方、返信生成・AIX 文面・テンプレ生成は suggested_aix_meta だけを読むため、表示後の生成は常に「ブレインの判断なし（T3）」になり、
//   お客様の質問・今話している物件・推奨アクションが消えた汎用の文になっていた（9/12 f568a14b: 2分で3回再生成して3回とも T3）。
//   画面の表示ロジックには手を入れず、サーバー側で「表示で消えただけ」の判断を last_brain_meta（本分析と同時に書かれる控え）から戻す。
//
// 戻してよい条件（すべて満たす時だけ）:
//   - suggested_aix_meta が空で、ai_draft が「表示済み」の印（__SHOWN__）＝消えた理由が表示であってスタッフの送信ではない
//     （送信は ai_draft を null にする。お客様の新着は webhook が消し、その時の控えは新着を見ていないので下の鮮度で弾かれる）
//   - 成約・終了などブレインの分析対象外のステータスではない
//   - 控えが本物の分析（source が aix_patch＝AIX 送信後の書き換え・cached＝分析の省略 ではない）
//   - 控えが最新のお客様発言を見ている（analyzed_msg_ts ≥ 最新のお客様発言 − 許容誤差。generate-reply の鮮度判定と同じ基準）

/** ブレインの判断が「最新のお客様発言を見た」とみなす許容誤差（同じ秒の書き込みの丸め）。brain-fetch-spec の鮮度判定と共有 */
export const BRAIN_FRESHNESS_TOLERANCE_MS = 5_000;

/** 画面が下書きを表示した印（page.tsx が ai_draft に書く） */
export const SHOWN_DRAFT_SENTINEL = "__SHOWN__";

const NON_RESTORABLE_SOURCES = new Set(["aix_patch", "cached"]);

export type ShownRestoreInput = {
  suggestedAixMeta: unknown;
  lastBrainMeta: unknown;
  aiDraft: string | null | undefined;
  status: string | null | undefined;
  latestCustomerMsgAt: string | null | undefined;
  skipStatuses: readonly string[];
};

export type ShownRestoreReason =
  | "has_meta" | "not_shown" | "skip_status" | "no_last_meta" | "not_restorable_source"
  | "no_ts" | "no_customer_msg" | "stale" | "restored";

export type ShownRestoreResult = { meta: Record<string, unknown> | null; restored: boolean; reason: ShownRestoreReason };

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 表示で消えただけのブレインの判断を控えから戻すかを決める。戻さない時は suggested_aix_meta（空なら null）をそのまま返す */
export function restoreMetaAfterShown(i: ShownRestoreInput): ShownRestoreResult {
  const current = asObject(i.suggestedAixMeta);
  if (current) return { meta: current, restored: false, reason: "has_meta" };
  if (i.aiDraft !== SHOWN_DRAFT_SENTINEL) return { meta: null, restored: false, reason: "not_shown" };
  if (i.status && i.skipStatuses.includes(i.status)) return { meta: null, restored: false, reason: "skip_status" };
  const last = asObject(i.lastBrainMeta);
  if (!last) return { meta: null, restored: false, reason: "no_last_meta" };
  if (NON_RESTORABLE_SOURCES.has(String(last.source ?? ""))) return { meta: null, restored: false, reason: "not_restorable_source" };
  const analyzedMs = typeof last.analyzed_msg_ts === "string" ? Date.parse(last.analyzed_msg_ts) : NaN;
  if (!Number.isFinite(analyzedMs)) return { meta: null, restored: false, reason: "no_ts" };
  const latestMs = i.latestCustomerMsgAt ? Date.parse(i.latestCustomerMsgAt) : NaN;
  if (!Number.isFinite(latestMs)) return { meta: null, restored: false, reason: "no_customer_msg" };
  if (analyzedMs < latestMs - BRAIN_FRESHNESS_TOLERANCE_MS) return { meta: null, restored: false, reason: "stale" };
  return { meta: last, restored: true, reason: "restored" };
}
