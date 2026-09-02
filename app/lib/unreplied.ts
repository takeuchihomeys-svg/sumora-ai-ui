// 未返信顧客メッセージ抽出の共通関数
// bg-async / generate-reply / page.tsx / cron で同一ロジックが7箇所複製されていた問題を解消

export type MsgRow = {
  sender: string;
  text: string | null;
  isAix?: boolean;
};

/**
 * メッセージ配列から「最後のスタッフ返信以降の顧客メッセージ」を抽出する
 * - [画像] / [動画] / null は除外
 * - 最大 maxCount 件（デフォルト10件）
 */
export function extractUnreplied(
  msgs: MsgRow[],
  maxCount = 10
): MsgRow[] {
  // 最後のスタッフ返信のインデックスを探す
  let lastStaffIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].sender === 'staff') {
      lastStaffIdx = i;
      break;
    }
  }
  const msgsAfterStaff = lastStaffIdx >= 0 ? msgs.slice(lastStaffIdx + 1) : msgs;
  return msgsAfterStaff
    .filter(
      (m) =>
        m.sender === 'customer' &&
        m.text &&
        m.text !== '[画像]' &&
        m.text !== '[動画]'
    )
    .slice(-maxCount);
}

/**
 * extractUnreplied の結果を改行連結したテキストとして返す
 */
export function buildTargetMessage(msgs: MsgRow[], maxCount = 10): string {
  return extractUnreplied(msgs, maxCount)
    .map((m) => m.text as string)
    .join('\n');
}
