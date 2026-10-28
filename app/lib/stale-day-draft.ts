// app/lib/stale-day-draft.ts — 日付をまたいだ古い下書き（「明日24日」「本日」）を出さない（純関数）
//
// 2026-10-28 竹内さんの今週の指摘 #4（愛実）: 10/23 14:45 の締め「明日24日17:30に現地エントランス…」→ お客様［スタンプ］の後、
//   翌日 10/24 9:34 に開くと下書き「明日24日17:30にお会いできるのを楽しみに」が残っていた。竹内さん「日にちまたいで今日になっているんやから、
//   今日ので行うようにする。今日の場合今日が内覧なので AIX の挨拶で行う」。
//   下書きは作った日の「明日・本日・今日」で書かれている＝日付が変わったら意味が変わる。内覧当日の挨拶は別の AIX（当日の朝の挨拶）が受け持つ。
// 決め: 下書きに日の言い方（明日・明後日・本日・今日・今夜）があり、作った日（JST）が今日より前なら、その下書きを出さない（消す）。
//   作った日は brain_analyzed_at（下書きはブレインの判断の後に作る・下書きの作った時刻の列は無い）。無ければ触らない（今日ブレインが読み直した番も触らない＝取りこぼしは安全側）。切替 STALE_DAY_DRAFT_CLEAR=on（既定 off）
// テスト: app/lib/__tests__/stale-day-draft.test.ts
import { jstDayStartMs } from "./jst-date";

export function staleDayDraftClearEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.STALE_DAY_DRAFT_CLEAR ?? "").trim().toLowerCase() === "on";
}

export const RELATIVE_DAY_RE = /明日|明後日|あした|あさって|本日|今日|今夜|今晩/;
/** 中身のある下書きか（見張りの印・案内の文ではない） */
const SENTINEL_RE = /^\s*(?:\[[^\]]*\]|__[A-Z_]+__)\s*$/;

export function isStaleRelativeDayDraft(draft: string | null | undefined, madeAtIso: string | null | undefined, nowMs: number): boolean {
  const t = String(draft ?? "");
  if (!t.trim() || SENTINEL_RE.test(t) || !RELATIVE_DAY_RE.test(t)) return false;
  const made = Date.parse(String(madeAtIso ?? ""));
  if (!Number.isFinite(made)) return false;
  return made < jstDayStartMs(nowMs);
}
