// app/lib/meeting-calendar.ts
// 2026-09-15 竹内（隼斗事例）「AIX 待ち合わせ送ったらカレンダー画面開かれて登録する形とする。内覧方法をそこに入力すれば、
//   内覧担当はカレンダー見るだけで内覧が出来る」。
//   待ち合わせの送信直後に、画面で入れた日付・時刻・物件・住所で内覧の予定を作り（無ければ）、予定を入れる画面を開いて内覧方法（鍵の開け方・
//   オートロック・ダイヤル・管理会社の連絡先・itandi）を入れてもらう。閉じても予定は残り、「内覧方法: 未入力」と分かる。
//   依存: jst-date のみ（画面から使う）
import { jstParts } from "./jst-date";

/** 内覧方法がまだ入っていない印（カレンダーの一覧で「内覧方法 未入力」を出す） */
export const VIEWING_METHOD_PENDING = "内覧方法: 未入力";

const DAY_MS = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, "0");
const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/：/g, ":").replace(/／/g, "/");

/**
 * 待ち合わせの画面入力（「9/18（金）」「9月18日」「明日」／「10:30」「10:30〜11:00」「10時半」）→ 日本時間の 'YYYY-MM-DD' と開始・終了 'HH:MM'。
 * 年は今日から近い方（60日より前の日付は来年）。日付が読めなければ null
 */
export function meetingToJst(meetingDate: string | null | undefined, meetingTime: string | null | undefined, nowMs: number = Date.now()): { ymd: string; start: string | null; end: string | null } | null {
  const d = toHalf(meetingDate ?? "");
  const now = jstParts(nowMs);
  const today = Date.UTC(now.y, now.m - 1, now.d);
  let t: number | null = null;
  const md = d.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if (md) {
    const mo = Number(md[1]); const da = Number(md[2]);
    t = Date.UTC(now.y, mo - 1, da);
    if (t < today - 60 * DAY_MS) t = Date.UTC(now.y + 1, mo - 1, da);
  } else if (/明後日|あさって/.test(d)) t = today + 2 * DAY_MS;
  else if (/明日|あした/.test(d)) t = today + DAY_MS;
  else if (/本日|今日/.test(d)) t = today;
  if (t === null) return null;
  const x = new Date(t);
  const ymd = `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`;

  const tm = toHalf(meetingTime ?? "");
  const times = [...tm.matchAll(/(\d{1,2})\s*(?::\s*(\d{2})|時\s*(半|\d{1,2}\s*分?)?)/g)].map((m) => {
    const h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : m[3] === "半" ? 30 : m[3] ? Number(m[3].replace(/\D/g, "")) : 0;
    return h >= 0 && h <= 23 && min >= 0 && min <= 59 ? `${pad2(h)}:${pad2(min)}` : null;
  }).filter((s): s is string => !!s);
  return { ymd, start: times[0] ?? null, end: times[1] ?? null };
}

/** 送信直後に作る内覧の予定のメモ（内覧方法はまだ）。物件名・住所は画面の入力 */
export function pendingViewingNotes(propertyName: string | null | undefined, address: string | null | undefined): string {
  const lines = [`【物件】${(propertyName ?? "").trim() || "（物件名未入力）"} / ${VIEWING_METHOD_PENDING}`];
  if ((address ?? "").trim()) lines.push(`住所: ${(address ?? "").trim()}`);
  return lines.join("\n");
}

/** 自動で作った・内覧方法が未入力の内覧の予定か（上書きしてよい予定） */
export function isReplaceableViewingNotes(notes: string | null | undefined): boolean {
  const n = notes ?? "";
  return n.includes(VIEWING_METHOD_PENDING) || /^件数:\s*\d+件\n物件:\s*（未確定）/.test(n);
}
