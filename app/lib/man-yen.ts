// app/lib/man-yen.ts
// 2026-10-02 ⑯ の G6（家賃 85,000 を Math.floor(rent/10000)+「万」で「8万」と書き、上限 8.5万のお客様をブレインが 8万と読む恐れ）:
//   円 → 万の表示を切り捨てない（85000 → "8.5"・80000 → "8"・123400 → "12.34"）。line-webhook-text.ts の manYen と同じ式。
//   画面（クライアント）からも使うので、サーバー専用の物を何も読み込まない小さな部品にした（画面からサーバーの部品を読むと本番のビルドだけ落ちる）
export function manYen(yen: number): string {
  return String(Math.round(yen / 100) / 100);
}
