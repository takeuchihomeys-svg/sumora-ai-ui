// app/lib/conversation-order.ts
// 一覧（LINE の会話リスト）の並び順。純関数・DB 依存なし。
//
// 2026-09-18 竹内「メッセージがきているお客さんで時間最近の方が上に配置。
//   この必ずは、メッセージが来ていない中なら、メッセージ来ていない中で上。
//   メッセージ来ているなら、メッセージ来ている中で上にする」
//
// 一覧の第一の目的は「お客様を待たせない」なので、**返事待ち（最後の発言がお客様）が常に上**。
// 【必ず】（お客様への約束・未履行）は順位を飛び越えるのではなく、**それぞれの中で上**に来る。
//   （同日中の最初の実装は【必ず】を一覧全体の先頭に出していたが、それだと
//    今まさに返事を待っているお客様が、約束だけの会話の下に押し下げられる）

/** 並べる時に見る1件分 */
export type ConversationOrderKey = {
  /** お客様からのメッセージが来ている（最後の発言がお客様＝返事待ち） */
  hasIncoming: boolean;
  /** 未履行の【必ず】の一番古い時刻（ms）。約束が無ければ null */
  promiseAt: number | null;
  /** 直近やり取りの時刻（ms） */
  updatedAtMs: number;
};

/** 時刻の文字列を ms に（読めない時は 0＝一番下）。並びに NaN を混ぜない */
export function sortMsOf(iso: string | null | undefined): number {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : 0;
}

/** 最後の発言がお客様か（lastSender が無い会話は最後のメッセージで見る） */
export function hasIncomingMessage(
  c: { lastSender?: string | null; messages?: ReadonlyArray<{ sender?: string | null }> },
): boolean {
  const sender = c.lastSender ?? c.messages?.[c.messages.length - 1]?.sender ?? null;
  return sender === "customer";
}

/**
 * 一覧の並び。
 *   ① メッセージが来ている（返事待ち）お客様が上
 *   ② その中で【必ず】（お客様への約束・未履行）がある会話が上
 *   ③ 【必ず】どうしは約束が古い順（放置が長いほど上＝一番忘れているものが一番上）
 *   ④ 残りは直近やり取り順（新しい方が上）
 * ②③は「メッセージが来ている組」「来ていない組」の**それぞれの中**で効く（組をまたいで飛び越えない）。
 */
export function compareConversationOrder(a: ConversationOrderKey, b: ConversationOrderKey): number {
  if (a.hasIncoming !== b.hasIncoming) return a.hasIncoming ? -1 : 1;
  const hasA = a.promiseAt !== null;
  const hasB = b.promiseAt !== null;
  if (hasA !== hasB) return hasA ? -1 : 1;
  if (hasA && hasB && a.promiseAt !== b.promiseAt) return (a.promiseAt as number) - (b.promiseAt as number);
  return b.updatedAtMs - a.updatedAtMs;
}
