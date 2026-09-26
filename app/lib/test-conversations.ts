// app/lib/test-conversations.ts
// テスト用の会話の一覧（1か所）。学習（返信の手本・行動・言い回し・勝ちパターン・差分学習・ナレッジ・AIX の学習・
// ブレインの改善・物件選びの学習）には**入れない**。画面・サーバーのどちらからも import 可（純粋な定数と関数だけ）。
//
// 2026-09-27 竹内さん「全部それで」: 9/27 の YUMA 実送信で save-reply-example が ai_reply_examples に
//   YUMA の行（entry_source=aix_action）を入れた。YUMA を外していたのは scoring-learning-server.ts だけだった。
//   → 一覧をここにまとめ、学習に入る全経路で isTestConversation / excludeTestConversations を通す。
//   足す時はこの配列に足すだけ（各経路は触らない）。

/** YUMA（竹内さん本人のテスト用 LINE・sumora） */
export const YUMA_CONVERSATION_ID = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

/** テスト用の会話の id */
export const TEST_CONVERSATION_IDS: readonly string[] = [YUMA_CONVERSATION_ID];
const TEST_SET: ReadonlySet<string> = new Set(TEST_CONVERSATION_IDS);

/** テスト用の会話か（null・空は false） */
export function isTestConversation(conversationId: string | null | undefined): boolean {
  return !!conversationId && TEST_SET.has(String(conversationId).trim());
}

/** 行の配列からテスト用の会話の行を外す（conversation_id 列を見る） */
export function excludeTestConversations<T extends { conversation_id?: string | null }>(rows: ReadonlyArray<T> | null | undefined): T[] {
  return (rows ?? []).filter((r) => !isTestConversation(r?.conversation_id ?? null));
}

/** Supabase の `.not("conversation_id", "in", TEST_CONVERSATIONS_IN)` に渡す形（読む時点で外す） */
export const TEST_CONVERSATIONS_IN = `(${TEST_CONVERSATION_IDS.join(",")})`;
