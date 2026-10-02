// app/lib/call-tap-view.ts
// トーク画面の「📞 電話ボタンが押されました」の印を出すかの判定（画面用・依存ゼロ）。
//   署名・通知は call-tap.ts（node:crypto を使うサーバー専用。画面から import すると本番のビルドが落ちるので分けている）
// 2026-10-02 竹内「不在の通知がはいるようにする」: 押した後にスタッフが何か送っていれば（電話終了後のまとめ・折り返しの連絡）印は消す

/** 印を出しておく長さ（押してから24時間を過ぎた物は出さない） */
export const CALL_TAP_BADGE_TTL_MS = 24 * 3600_000;

export function shouldShowCallTapBadge(
  callTappedAt: string | null | undefined,
  messages: ReadonlyArray<{ sender: string; rawCreatedAt?: string | null }>,
  nowMs: number = Date.now(),
): boolean {
  if (!callTappedAt) return false;
  const tapMs = Date.parse(callTappedAt);
  if (!Number.isFinite(tapMs) || nowMs - tapMs > CALL_TAP_BADGE_TTL_MS) return false;
  return !messages.some((m) => {
    if (m.sender !== "staff" || !m.rawCreatedAt) return false;
    const t = Date.parse(m.rawCreatedAt);
    return Number.isFinite(t) && t > tapMs;
  });
}
