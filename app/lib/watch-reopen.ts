// app/lib/watch-reopen.ts — 見張りの番（line_watch_turns）を、判定の後にお客様の発言が足された時に読み直す（純関数・既定 off）
//
// 2026-11-21 作業員K2（台帳 #313・統括役の頼み・作業員L に知らせ済み）: 14日で staff_aix（スタッフが押した AIX）が空なのに窓の中に AIX の記録がある番 23 のうち、
//   本当の取りこぼしは 2（番 13674・14500）。どちらも evaluated_at（11/13・11/14）が customer_last_at（11/21・11/16）より前＝
//   窓が閉じて final にした後で同じ番の行にお客様の発言が足され（customer_last_at が進んだ）、その後に押した AIX を読み直していなかった。
//   evaluateLineWatchTurns は ①直近4日の customer_turn_at の行と ②未判定の行しか読まず ③final で同じ版の行は読み直さない。
//   直し: customer_last_at が evaluated_at より後の行も読み（直近4日の customer_last_at）、done にしない。
// ■ スイッチ WATCH_REOPEN_ON_NEW_CUSTOMER: 既定 off（今まで通り）／on
// テスト: app/lib/__tests__/watch-reopen.test.ts
type Env = Record<string, string | undefined>;
export function watchReopenOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.WATCH_REOPEN_ON_NEW_CUSTOMER ?? "").trim().toLowerCase() === "on";
}
/** 判定の後に、同じ番にお客様の発言が足されたか（読み直す番か） */
export function needsReopen(row: { customer_last_at?: string | null; evaluated_at?: string | null }): boolean {
  if (!row.customer_last_at || !row.evaluated_at) return false;
  const a = Date.parse(row.customer_last_at), b = Date.parse(row.evaluated_at);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}
