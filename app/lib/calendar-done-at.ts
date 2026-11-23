// 2026-11-23 作業員L（#663）: calendar_events の済みの時刻（done_at timestamptz・既定 null）
//   済みにする所は全部 calendarDonePatch(true) で is_done と done_at を一緒に書く。済みを戻す（is_done=false）時は done_at を null に戻す。
//   試験の組み直し（scripts/lib/exam-situation-now.ts）は doneAsOf でその番の時刻の済み／開いたを読む
//   （done_at がその番より後＝その番では開いていた・done_at が無い古い行は今の is_done のまま＝今まで通り）。
//   画面（カレンダー・会話の予定）の表示は is_done だけを読むので変わらない。

export type CalendarDonePatch = { is_done: boolean; done_at: string | null };

/** 済み／戻しの書き込みの中身。済み＝今の時刻、戻し＝null */
export function calendarDonePatch(isDone: boolean, nowIso: string = new Date().toISOString()): CalendarDonePatch {
  return isDone ? { is_done: true, done_at: nowIso } : { is_done: false, done_at: null };
}

/** その時刻（cutMs）に済みだったか。開いている行は開いたまま。done_at が無い・読めない済みの行は今まで通り済み */
export function doneAsOf(row: { is_done?: boolean | null; done_at?: string | null }, cutMs: number): boolean {
  if (row.is_done !== true) return false;
  if (!row.done_at) return true;
  const t = Date.parse(row.done_at);
  if (!Number.isFinite(t) || !Number.isFinite(cutMs)) return true;
  return t <= cutMs;
}
