// app/lib/pickup-list-order.ts — AIX ツール（ピックアップのタブ）のお客様の一覧の並び（純関数・DB なし）
//
// 2026-10-28 竹内さん「AIX ツールで解析したのは一覧の一番上に繰り上げて分かりやすいようにする」:
//   旧: 並びは LINE の一覧と同じ（会話の updated_at）だけ＝拡張・ブレインがピックアップを解析しても、会話が動いていなければ下のまま。
//   新（PICKUP_ORDER_ANALYZED_FIRST=on の時だけ・既定 off）: 並びの時刻＝「会話の更新」と「一番新しい解析（ピックアップの回）」の新しい方。
//     解析した人がその時刻で一番上に来る。その後に LINE が動いた人は今まで通り LINE の時刻で上がる。
// テスト: app/lib/__tests__/pickup-list-order.test.ts

export function pickupOrderAnalyzedFirstEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.PICKUP_ORDER_ANALYZED_FIRST ?? "").trim().toLowerCase() === "on";
}

/** 並びの時刻（ISO）。enabled=false は今まで通り convUpdatedAt ?? fallback */
export function pickupListOrderAt(o: { convUpdatedAt: string | null | undefined; lastPickupAt: string | null | undefined; fallback: string }, enabled: boolean): string {
  const base = o.convUpdatedAt ?? o.fallback;
  if (!enabled) return base;
  const a = Date.parse(base), b = Date.parse(o.lastPickupAt ?? "");
  if (!Number.isFinite(b)) return base;
  if (!Number.isFinite(a) || b > a) return new Date(b).toISOString();
  return base;
}
