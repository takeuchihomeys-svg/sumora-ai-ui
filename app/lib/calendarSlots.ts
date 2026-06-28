import { supabase } from "./supabase";

const WEEKDAYS_JP = ["日", "月", "火", "水", "木", "金", "土"];
const WORK_START = 11 * 60; // 11:00
const WORK_END   = 18 * 60; // 18:00
const MIN_SLOT   = 2 * 60;
const MAX_SLOT   = 3 * 60;
const BUFFER     = 60;      // 予定の前後に確保する最低バッファ（1時間）

const minToStr = (m: number) =>
  `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

const fmtDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function calcSlots(busy: Array<[number, number]>): string[] {
  // 各予定の前後にBUFFER分の余裕を追加（内覧はその予定の1時間前後を空ける）
  const buffered: Array<[number, number]> = busy.map(([s, e]) => [
    Math.max(s - BUFFER, WORK_START),
    Math.min(e + BUFFER, WORK_END),
  ]);
  const sorted = buffered.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    if (merged.length > 0 && s < merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }
  const slots: string[] = [];
  let cursor = WORK_START;
  const blocks: Array<[number, number]> = [...merged, [WORK_END, WORK_END]];
  for (const [bs, be] of blocks) {
    const freeStart = cursor;
    const freeEnd   = Math.min(bs, WORK_END);
    const freeLen   = freeEnd - freeStart;
    if (freeLen >= MIN_SLOT) {
      slots.push(`${minToStr(freeStart)}〜${minToStr(Math.min(freeStart + MAX_SLOT, freeEnd))}`);
    }
    cursor = Math.max(cursor, Math.min(be, WORK_END));
  }
  return slots;
}

export type CalendarDayResult = {
  label: string;       // "本日 6/14(土)"
  slots: string[];     // ["10:00〜13:00", "14:00〜17:00"]
  fullyBooked: boolean;
  noEvents: boolean;
};

export async function fetchCalendarSlots(): Promise<{
  days: CalendarDayResult[];
  infoString: string; // AIに渡す文字列
}> {
  const today = new Date();
  const days  = Array.from({ length: 3 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    return d;
  });
  const fromDate = fmtDate(days[0]);
  const toDate   = fmtDate(days[2]);

  const startISO = new Date(`${fromDate}T00:00:00`).toISOString();
  const endISO   = new Date(`${toDate}T23:59:59`).toISOString();

  const [evResult, tasksRaw] = await Promise.all([
    supabase
      .from("calendar_events")
      .select("start_at, end_at, event_type, title, all_day")
      .gte("start_at", startISO)
      .lte("start_at", endISO)
      .order("start_at"),
    fetch(`/api/daily-tasks?from=${fromDate}&to=${toDate}`).then(r => r.ok ? r.json() : []),
  ]);

  const events = (evResult.data || []) as Array<{
    start_at: string; end_at: string | null; event_type: string; title: string; all_day: boolean;
  }>;
  const tasks = (Array.isArray(tasksRaw) ? tasksRaw : []) as Array<{
    content: string; date: string; time: string; end_time: string; done: boolean;
  }>;

  const resultDays: CalendarDayResult[] = [];
  const infoLines: string[] = [];

  // 現在時刻（分）- 今日のスロットフィルタリングに使用
  const nowMin = today.getHours() * 60 + today.getMinutes();

  // スロット文字列（"10:00〜13:00"）の終了時刻を分に変換
  const slotEndMin = (slot: string): number => {
    const m = slot.match(/〜(\d{1,2}):(\d{2})/);
    return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 0;
  };

  for (let i = 0; i < 3; i++) {
    const day   = days[i];
    const dateKey = fmtDate(day);
    const month = day.getMonth() + 1;
    const date  = day.getDate();
    const wd    = WEEKDAYS_JP[day.getDay()];
    const label_prefix = i === 0 ? "本日" : i === 1 ? "明日" : "明後日";
    const label = `${label_prefix} ${month}/${date}(${wd})`;
    const shortLabel = `${label_prefix}(${month}/${date}${wd})`;

    const busy: Array<[number, number]> = [];

    for (const ev of events) {
      const s = new Date(ev.start_at);
      if (fmtDate(s) !== dateKey) continue;
      if (ev.all_day) {
        // 「定休・休業・休み・休日・お休み」などの休業系のみ終日ブロック
        // それ以外の全日イベント（会議メモ・リマインダー等）は時間をブロックしない
        const isClosedDay = /定休|休業|休み|休日|お休み|closed|holiday/i.test(ev.title || "") || ev.event_type === "holiday";
        if (isClosedDay) {
          busy.push([WORK_START, WORK_END]);
        }
      } else {
        const sm = s.getHours() * 60 + s.getMinutes();
        const em = ev.end_at
          ? new Date(ev.end_at).getHours() * 60 + new Date(ev.end_at).getMinutes()
          : sm + 60;
        busy.push([Math.max(sm, WORK_START), Math.min(em, WORK_END)]);
      }
    }

    for (const t of tasks) {
      if (t.date !== dateKey || t.done) continue;
      if (!t.time) {
        // 時間なしタスクは終日ブロックしない（タスクの存在は内覧枠に影響させない）
        continue;
      } else {
        const [th, tm] = t.time.split(":").map(Number);
        const sm = (th || 0) * 60 + (tm || 0);
        let em = sm + 60;
        if (t.end_time) {
          const [eh, emin] = t.end_time.split(":").map(Number);
          em = (eh || 0) * 60 + (emin || 0);
        }
        busy.push([Math.max(sm, WORK_START), Math.min(em, WORK_END)]);
      }
    }

    let slots      = calcSlots(busy);
    const noEvents   = busy.length === 0;

    // 今日（i===0）は現在時刻を過ぎたスロットを除外
    if (i === 0) {
      slots = slots.filter(s => slotEndMin(s) > nowMin);
    }

    const fullyBooked = !noEvents && slots.length === 0;

    let defaultSlots = ["10:00〜13:00", "13:00〜16:00", "16:00〜18:00"];

    // 今日のデフォルトスロットも現在時刻で絞り込む
    if (i === 0) {
      defaultSlots = defaultSlots.filter(s => slotEndMin(s) > nowMin);
    }

    if (noEvents && defaultSlots.length === 0) {
      // 今日・予定なし・全スロット時間切れ → 案内不可扱い
      resultDays.push({ label, slots: [], fullyBooked: true, noEvents: true });
    } else if (noEvents) {
      infoLines.push(`${shortLabel} ${defaultSlots.join(" / ")}`);
      resultDays.push({ label, slots: defaultSlots, fullyBooked: false, noEvents: true });
    } else if (fullyBooked) {
      // 案内不可の日はinfoLinesに含めない（AIに渡さない）
      resultDays.push({ label, slots: [], fullyBooked: true, noEvents: false });
    } else {
      infoLines.push(`${shortLabel} ${slots.join(" / ")}`);
      resultDays.push({ label, slots, fullyBooked: false, noEvents: false });
    }
  }

  return { days: resultDays, infoString: infoLines.join("\n") };
}
