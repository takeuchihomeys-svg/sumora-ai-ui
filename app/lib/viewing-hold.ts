// app/lib/viewing-hold.ts
// 内覧の候補日時を「時間確保」としてカレンダーに置く／決まったら残りを消す（純関数・DB 依存なし）。
//
// 2026-09-16 竹内（カイナ事例）「このように内覧調整いれたらカレンダーで時間確保とする。決定したら確保しているそのお客さんの候補時間他のは消えるようにする」:
//   AIX【内覧日調整】で「直近ですと 明日 9/16(水) 15:30〜17:00にてご案内可能です」と送った後、スタッフが手でカレンダーに
//   「🐈‍⬛ 内覧（notes: 【時間確保】）15:30〜17:30」を入れていた。手入力の型（title「〇〇 内覧」・notes 先頭【時間確保】）に合わせて自動で作る。
//   確保した枠は空き時間の計算（calendarSlots）で埋まるので、他のお客様に同じ時間を出さない。
import { jstParts, WEEKDAYS_JA } from "./jst-date";

/** 手入力と同じ印（カレンダーの notes の先頭）。この印がある内覧の予定＝まだ決まっていない候補 */
export const VIEWING_HOLD_MARK = "【時間確保】";
const DAY_MS = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, "0");
const toHalf = (s: string) => (s ?? "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/：/g, ":").replace(/[～〜~]/g, "〜").replace(/／/g, "/");

export type HoldSlot = { ymd: string; start: string; end: string; label: string };

/** 時間確保の予定か（notes の先頭が【時間確保】） */
export function isViewingHoldNotes(notes: string | null | undefined): boolean {
  return (notes ?? "").trimStart().startsWith(VIEWING_HOLD_MARK);
}
/** 時間確保の予定のメモ（1行目は手入力と同じ印・2行目に候補の元の表記） */
export function holdNotes(label: string): string {
  return `${VIEWING_HOLD_MARK}\n候補: ${label}`;
}
/** 時間確保の予定の名前（手入力と同じ「〇〇 内覧」） */
export function holdTitle(customerName: string | null | undefined): string {
  const n = (customerName ?? "").trim();
  return n ? `${n} 内覧` : "内覧";
}

/**
 * AIX【内覧日調整】の候補の行（「明日 9/16(水) 15:30〜17:00」「9/18(金) 10:30〜11:30 / 17:00〜18:30」「本日 13:00〜16:00」）を
 * 日本時間の 'YYYY-MM-DD' と開始・終了に直す。時刻が1つだけなら2時間の枠。日付が読めない行は落とす
 */
export function parseCandidateSlots(calendarInfo: string | null | undefined, nowMs: number = Date.now()): HoldSlot[] {
  const out: HoldSlot[] = [];
  const now = jstParts(nowMs);
  const todayUtc = Date.UTC(now.y, now.m - 1, now.d);
  for (const rawLine of (calendarInfo ?? "").split("\n")) {
    const line = toHalf(rawLine).trim();
    if (!line) continue;
    // 日付: 「9/16」「9月16日」／「本日」「明日」「明後日」
    let dayUtc: number | null = null;
    const md = line.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
    if (md) {
      const mo = Number(md[1]); const da = Number(md[2]);
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
        dayUtc = Date.UTC(now.y, mo - 1, da);
        if (dayUtc < todayUtc - 60 * DAY_MS) dayUtc = Date.UTC(now.y + 1, mo - 1, da); // 年をまたぐ
      }
    } else if (/明後日/.test(line)) dayUtc = todayUtc + 2 * DAY_MS;
    else if (/明日/.test(line)) dayUtc = todayUtc + DAY_MS;
    else if (/本日|今日/.test(line)) dayUtc = todayUtc;
    if (dayUtc === null) continue;
    const d = new Date(dayUtc);
    const ymd = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    // 時刻の組（「15:30〜17:00」が複数あることもある。「9/16(水)」の (水) は時刻ではない）
    const ranges = [...line.matchAll(/(\d{1,2}):(\d{2})\s*(?:〜\s*(\d{1,2}):(\d{2}))?/g)];
    for (const r of ranges) {
      const sh = Number(r[1]); const sm = Number(r[2]);
      if (sh > 23 || sm > 59) continue;
      const start = `${pad2(sh)}:${pad2(sm)}`;
      let end: string;
      if (r[3] !== undefined && r[4] !== undefined) {
        const eh = Number(r[3]); const em = Number(r[4]);
        end = eh <= 23 && em <= 59 ? `${pad2(eh)}:${pad2(em)}` : start;
      } else {
        const tot = Math.min(sh * 60 + sm + 120, 23 * 60 + 59); // 時刻が1つだけなら2時間の枠
        end = `${pad2(Math.floor(tot / 60))}:${pad2(tot % 60)}`;
      }
      if (end <= start) continue;
      const wd = WEEKDAYS_JA[new Date(dayUtc).getUTCDay()];
      const label = `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${wd}) ${start}〜${end}`;
      if (!out.some((x) => x.ymd === ymd && x.start === start && x.end === end)) out.push({ ymd, start, end, label });
    }
  }
  return out;
}

/** カレンダーに入れる行（JST の ISO 文字列で作る） */
export function holdEventRow(slot: HoldSlot, customerName: string | null | undefined, conversationId: string | null): {
  title: string; event_type: string; customer_name: string | null; conversation_id: string | null; start_at: string; end_at: string; all_day: boolean; notes: string;
} {
  return {
    title: holdTitle(customerName),
    event_type: "viewing",
    customer_name: (customerName ?? "").trim() || null,
    conversation_id: conversationId,
    start_at: new Date(`${slot.ymd}T${slot.start}:00+09:00`).toISOString(),
    end_at: new Date(`${slot.ymd}T${slot.end}:00+09:00`).toISOString(),
    all_day: false,
    notes: holdNotes(slot.label),
  };
}

/**
 * 内覧が決まった時に残す1件を選ぶ（決まった日時と同じ日の確保があればそれを本当の内覧に書き換え、残りは消す）。
 * 戻り: keepId＝書き換える確保の id（無ければ null）／deleteIds＝消す確保の id
 */
export function planHoldCleanup(
  holds: ReadonlyArray<{ id: number; start_at: string; notes: string | null }>,
  decidedYmd: string,
  decidedStart: string | null,
): { keepId: number | null; deleteIds: number[] } {
  const onlyHolds = holds.filter((h) => isViewingHoldNotes(h.notes));
  if (onlyHolds.length === 0) return { keepId: null, deleteIds: [] };
  const ymdOf = (iso: string) => { const p = jstParts(iso); return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`; };
  const hmOf = (iso: string) => { const p = jstParts(iso); return `${pad2(p.hour)}:${pad2(p.minute)}`; };
  const sameDay = onlyHolds.filter((h) => ymdOf(h.start_at) === decidedYmd);
  // 2026-09-16（𝒮 さん事例）: 決まった時刻が分かっている時は、その時刻の確保だけを残す。
  //   旧: 一致する確保が無いと同じ日の先頭（sameDay[0]）を残していたため、12:00 で決まったのに 16:00〜18:00 の確保が
  //   カレンダーに残り、他のお客様への候補からその枠が消えたままになっていた（実データ: 𝒮 9/17 の ev 536）
  const keep = decidedStart
    ? (sameDay.find((h) => hmOf(h.start_at) === decidedStart) ?? null)
    : (sameDay[0] ?? null);
  return { keepId: keep?.id ?? null, deleteIds: onlyHolds.filter((h) => h.id !== keep?.id).map((h) => h.id) };
}
