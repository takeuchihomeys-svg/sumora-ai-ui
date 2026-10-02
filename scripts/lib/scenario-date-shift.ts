// scripts/lib/scenario-date-shift.ts
// 2026-10-02 ⑫（2巡目に見つけた道具の穴・竹内さんの指示「場面の日付を今に合わせてずらす・内覧日が未来になるように」）:
//   本番の会話の場面を YUMA で流すと、場面の「9/11」が今日（10/2）から見て過去になり、ブレインが内覧調整・内覧後の挨拶を選んだ。
//   場面の元の時刻から今日までの日数だけ、文の中の日付（M/D・M月D日・曜日の括弧）をずらす。URL の中は触らない。
const WD = ["日", "月", "火", "水", "木", "金", "土"];

/** 場面の元の時刻（src の "conv8 YYYY-MM-DDTHH:MM"・UTC）から今日（JST）までの日数（7の倍数に切り上げ） */
export function shiftDaysFor(src: string, now = Date.now()): number {
  const m = String(src ?? "").match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
  if (!m) return 0;
  const jstDay = (ms: number) => Math.floor((ms + 9 * 3600_000) / 86_400_000);
  // 曜日を変えない（「土日なら」「金曜の夜」の話が崩れない）よう7日の倍数に切り上げる＝場面の日付は今日以降に来る
  const diff = jstDay(now) - jstDay(Date.parse(`${m[1]}:00Z`));
  return diff <= 0 ? 0 : Math.ceil(diff / 7) * 7;
}

function shiftMD(year: number, mo: number, d: number, days: number): { mo: number; d: number; wd: string } | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(year, mo - 1, d) + days * 86_400_000;
  const x = new Date(t);
  return { mo: x.getUTCMonth() + 1, d: x.getUTCDate(), wd: WD[x.getUTCDay()] };
}

/** 文の中の日付を days 日ずらす（曜日の括弧があれば曜日も付け直す）。year は場面の年 */
export function shiftDatesInText(text: string, days: number, year: number): string {
  if (!days || !text) return text;
  return String(text).split(/(https?:\/\/\S+)/).map((part, i) => {
    if (i % 2 === 1) return part; // URL
    let s = part.replace(/(?<![0-9/])(\d{1,2})月(\d{1,2})日((?:\s*[（(][月火水木金土日](?:曜日?)?[）)])?)/g, (all, mo, d, wdp: string) => {
      const r = shiftMD(year, Number(mo), Number(d), days);
      if (!r) return all;
      return `${r.mo}月${r.d}日${wdp ? wdp.replace(/[月火水木金土日](?=(?:曜日?)?[）)])/, r.wd) : ""}`;
    });
    s = s.replace(/(?<![0-9/.:])(\d{1,2})\/(\d{1,2})(?![0-9/]|負担|程度|ずつ)((?:日)?(?:\s*[（(][月火水木金土日](?:曜日?)?[）)])?)/g, (all, mo, d, tail: string) => {
      const r = shiftMD(year, Number(mo), Number(d), days);
      if (!r) return all;
      return `${r.mo}/${r.d}${tail ? tail.replace(/[月火水木金土日](?=(?:曜日?)?[）)])/, r.wd) : ""}`;
    });
    return s;
  }).join("");
}
