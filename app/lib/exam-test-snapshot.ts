// app/lib/exam-test-snapshot.ts — 試験（exam-aix-text）の問題に持たせた「その番の時点の写し」を、テスト専用の会話の時だけ入口が読む
//
// 2026-10-28 作業員5（作業員3の引き継ぎ 1）: exam-aix-text の問題は会話だけを持ち、売上サポの行（property_pickups）・送った資料の読み（sent_image_properties）・
//   AIX の履歴（aix_usage_logs）は試験の会話（YUMA4 等）の今の行を読んでいた＝その番の材料が届かず、別の作業の残りが混ざっていた。
//   問題を作る時にその番の時点の行を写し（scripts/exam-aix-text-snap.ts）、試験の時だけ DB の代わりに渡す。
//   本番では isTestModeAllowed が false＝読まない（本文に testSnapshot が来ても無視）。
import { isTestModeAllowed } from "./llm-test-mode";
import { isTestOnlyConversation } from "./test-conversations";

export type ExamTestSnapshot = {
  /** property_pickups の行（その番の時点より前に作られた物・この会話） */
  pickups?: Array<Record<string, unknown>>;
  /** sent_image_properties の行（その番の時点より前） */
  sentImages?: Array<Record<string, unknown>>;
  /** aix_usage_logs の行（その番の時点より前・新しい順） */
  aixUsage?: Array<Record<string, unknown>>;
};

/** テスト専用の会話＋手元のテストの時だけ写しを返す（無ければ null＝今まで通り DB を読む） */
export function examTestSnapshot(body: unknown, conversationId: unknown, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): ExamTestSnapshot | null {
  const snap = (body as { testSnapshot?: unknown } | null | undefined)?.testSnapshot;
  if (!snap || typeof snap !== "object") return null;
  if (!isTestModeAllowed(env) || typeof conversationId !== "string" || !isTestOnlyConversation(conversationId)) return null;
  return snap as ExamTestSnapshot;
}

/** 写しの行を DB の問い合わせと同じ並び・絞りで返す（created_at の新しい順・limit） */
export function snapshotRows<T = Record<string, unknown>>(rows: ReadonlyArray<Record<string, unknown>> | undefined, o: { where?: (r: Record<string, unknown>) => boolean; limit?: number } = {}): T[] {
  const list = (rows ?? []).filter((r) => r && typeof r === "object" && (!o.where || o.where(r)));
  const t = (r: Record<string, unknown>) => Date.parse(String(r.created_at ?? r.sent_at ?? "")) || 0;
  return [...list].sort((a, b) => t(b) - t(a)).slice(0, o.limit ?? 1000) as T[];
}
