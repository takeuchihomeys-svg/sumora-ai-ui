// app/lib/viewing-confirmed.ts — カレンダーの内覧の予定（event_type viewing）が「決まった内覧」か（純関数・作業員N2・2026-11-21・台帳 #579 の続き）
//
// event_type viewing には、本当の内覧のほかに次の2つが入る（11/21 の本番30日: viewing 159件のうち 決まった内覧 35・未確定 101・時間確保 23）:
//   ① ブレインの「内覧調整」のタスク … brain-core createCalendarEventFromBrainAction（viewing_invite の判断）・save-reply-example の約束の読み取り。
//      終日 10:00・notes「件数: 1件 / 物件: （未確定）（現地）」。内覧の候補日を送る仕事であって、内覧の日ではない
//   ② 候補の【時間確保】 … viewing-hold（候補日時を送った時に枠を押さえる）。まだ決まっていない
// #579 の8会話はどれもこの2つだけで、内覧は無かった。今の読み手のうち、申込ツールへの同期（shouldSyncViewingToScreening）・見張り（line-watch-turn）・
//   空き枠（isOutingViewingNotes）は既に分けているが、今日の内覧の読み（brain-core の is_hot・customer-hub の予定と食い違い）は分けていなかった。
// 時刻のある未確定（スタッフの返信の約束から「14時にご案内」を読んだ物など）は、日時が決まった内覧として残す（物件だけ未定）。
import { isViewingHoldNotes } from "./viewing-hold";

type Env = Record<string, string | undefined>;
/** 今日の内覧などの読みで「決まった内覧」だけを数える（既定 off・入れる VIEWING_CONFIRMED_ONLY=on） */
export const viewingConfirmedOnlyOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.VIEWING_CONFIRMED_ONLY ?? "").trim().toLowerCase() === "on";

const UNDECIDED_RE = /物件:\s*（未確定）/;

/** 決まった内覧の予定か。event_type を渡せば viewing 以外は false */
export function isConfirmedViewingEvent(e: { event_type?: string | null; all_day?: boolean | null; title?: string | null; notes?: string | null }): boolean {
  if (e.event_type != null && e.event_type !== "viewing") return false;
  const notes = e.notes ?? "";
  if (isViewingHoldNotes(notes)) return false;
  if (e.all_day && (UNDECIDED_RE.test(notes) || /内覧調整\s*$/.test(e.title ?? ""))) return false;
  return true;
}
