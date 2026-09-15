import { supabase } from "./supabase";
import { jstParts, jstYmd } from "./jst-date";

const WEEKDAYS_JP = ["日", "月", "火", "水", "木", "金", "土"];
const DAY_MS = 86_400_000;
// 2026-09-15 竹内「時間10:30〜18:30まで可能にする。物件の内覧の場所もあるので今まで通り2時間以上の幅にする」
//   （旧 11:00〜18:00。隼斗事例: スタッフの実送信は 9/18「10:30〜11:30 17:00〜18:30」）
const WORK_START = 10 * 60 + 30; // 10:30
const WORK_END   = 18 * 60 + 30; // 18:30
/** 内覧の案内時間の初期値（カレンダーの空き枠が無い日を手で ON にした時など） */
export const VIEWING_DAY_START = "10:30";
export const VIEWING_DAY_END   = "18:30";
const MIN_SLOT   = 2 * 60;  // 物件間の移動があるので2時間以上の空きだけ
const MAX_SLOT   = 3 * 60;
const BUFFER     = 60;      // 予定の前後に確保する最低バッファ（1時間）

const minToStr = (m: number) =>
  `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;


/** 予定（分の区間）から内覧可能な時間帯を出す（10:30〜18:30・予定の前後1時間・2時間以上の空き・1枠は最大3時間） */
export function calcSlots(busy: Array<[number, number]>): string[] {
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

/**
 * 内覧可能な時間帯（本日・明日・明後日＋ extraYmds の日）。
 * 2026-09-15 竹内（隼斗事例）: お客様の希望日（「18日はどうでしょうか？」）が3日より先だと空き時間を出せず、最初の空き日（9/16）に置き換わっていた
 *   → 希望日（'YYYY-MM-DD'・最大5日）も同じ計算で出す（ラベルは「9/18(金)」）。日付・曜日・時刻は日本時間で計算する（端末の時間帯に左右されない・jst-date）
 */
export async function fetchCalendarSlots(extraYmds: ReadonlyArray<string> = []): Promise<{
  days: CalendarDayResult[];
  infoString: string; // AIに渡す文字列
}> {
  const now = jstParts();
  const todayUtc = Date.UTC(now.y, now.m - 1, now.d);
  const baseYmds = [0, 1, 2].map((i) => jstYmd(todayUtc + i * DAY_MS - 9 * 3600 * 1000));
  const extras = [...new Set(extraYmds.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && s > baseYmds[2]))].sort().slice(0, 5);
  const allYmds = [...baseYmds, ...extras];
  const fromDate = allYmds[0];
  const toDate   = allYmds[allYmds.length - 1];

  const startISO = new Date(`${fromDate}T00:00:00+09:00`).toISOString();
  const endISO   = new Date(`${toDate}T23:59:59+09:00`).toISOString();

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

  // 現在時刻（分・日本時間）- 今日のスロットフィルタリングに使用
  const nowMin = now.hour * 60 + now.minute;
  const jstMin = (iso: string) => { const p = jstParts(iso); return p.hour * 60 + p.minute; };

  // スロット文字列（"10:00〜13:00"）の終了時刻を分に変換
  const slotEndMin = (slot: string): number => {
    const m = slot.match(/〜(\d{1,2}):(\d{2})/);
    return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 0;
  };

  for (let i = 0; i < allYmds.length; i++) {
    const dateKey = allYmds[i];
    const [yy, mo, dd] = dateKey.split("-").map(Number);
    const month = mo;
    const date  = dd;
    const wd    = WEEKDAYS_JP[new Date(Date.UTC(yy, mo - 1, dd)).getUTCDay()];
    const label_prefix = i === 0 ? "本日" : i === 1 ? "明日" : i === 2 ? "明後日" : "";
    const label = label_prefix ? `${label_prefix} ${month}/${date}(${wd})` : `${month}/${date}(${wd})`;
    const shortLabel = label_prefix ? `${label_prefix}(${month}/${date}${wd})` : `${month}/${date}(${wd})`;

    const busy: Array<[number, number]> = [];

    for (const ev of events) {
      if (jstYmd(ev.start_at) !== dateKey) continue;
      if (ev.all_day) {
        // 「定休・休業・休み・休日・お休み」などの休業系のみ終日ブロック
        // それ以外の全日イベント（会議メモ・リマインダー等）は時間をブロックしない
        const isClosedDay = /定休|休業|休み|休日|お休み|closed|holiday/i.test(ev.title || "") || ev.event_type === "holiday";
        if (isClosedDay) {
          busy.push([WORK_START, WORK_END]);
        }
      } else {
        const sm = jstMin(ev.start_at);
        const em = ev.end_at ? jstMin(ev.end_at) : sm + 60;
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

    let defaultSlots = ["13:00〜16:00", "16:00〜18:30"];

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
