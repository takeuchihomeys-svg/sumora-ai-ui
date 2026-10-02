import { supabase } from "./supabase";
import { jstParts, jstYmd } from "./jst-date";
import { isViewingHoldNotes } from "./viewing-hold";

import { planDaySlots, isOutingViewingNotes, VIEWING_DAY_START, VIEWING_DAY_END, type SlotBusy } from "./viewing-slot-plan";
import { VIEWING_LOOKAHEAD_DAYS, baseDaysToKeep } from "./viewing-candidates";

const WEEKDAYS_JP = ["日", "月", "火", "水", "木", "金", "土"];
const DAY_MS = 86_400_000;
// 2026-09-30 竹内「内覧は1件なら1〜2時間の枠・件数で枠を増やす・予定の住所と移動時間も入れる・始まり 11:00〜終了 18:30」
//   枠の決まり（開始と終了の範囲・件数ごとの長さ・予定との間の空け方・長い空きの切り方）は viewing-slot-plan.ts の1か所。
//   （旧 2026-09-15: 10:30〜18:30・予定の前後1時間・2時間以上の空き・1枠は最大3時間）
/** 内覧の案内時間の初期値（カレンダーの空き枠が無い日を手で ON にした時など） */
export { VIEWING_DAY_START, VIEWING_DAY_END };
/** 基準の3日（本日・明日・明後日）に足せる日の上限。お客様の希望日＋退去予定日以降の日が両方入るので 8 日 */
const MAX_EXTRA_DAYS = 8;

/** 予定（分の区間）から内覧可能な時間帯を出す（出かけない予定として扱う＝前後1時間）。決まりは viewing-slot-plan.ts planDaySlots */
export function calcSlots(busy: Array<[number, number]>, opts: { count?: number | null } = {}): string[] {
  return planDaySlots({ busy: busy.map(([start, end]) => ({ start, end })), count: opts.count }).slots;
}

export type CalendarDayResult = {
  label: string;       // "本日 6/14(土)"
  /** その日（JST・"YYYY-MM-DD"）。ラベルの「6/14」は年を持たないので、日付の比較はこちらで行う（年跨ぎで狂わない） */
  ymd: string;
  slots: string[];     // ["10:00〜13:00", "14:00〜17:00"]
  fullyBooked: boolean;
  noEvents: boolean;
};

/**
 * 内覧可能な時間帯（本日・明日・明後日＋ extraYmds の日）。
 * 2026-09-15 竹内（隼斗事例）: お客様の希望日（「18日はどうでしょうか？」）が3日より先だと空き時間を出せず、最初の空き日（9/16）に置き換わっていた
 *   → 希望日（'YYYY-MM-DD'・最大5日）も同じ計算で出す（ラベルは「9/18(金)」）。日付・曜日・時刻は日本時間で計算する（端末の時間帯に左右されない・jst-date）
 */
export async function fetchCalendarSlots(
  extraYmds: ReadonlyArray<string> = [],
  // 2026-09-16 竹内（カイナ事例）: そのお客様自身の「時間確保」（前に送った候補）は、そのお客様への提案では空き扱いにする
  //   （他のお客様に対しては確保として埋まったまま）。決まったら確保は消える
  // 2026-09-30 竹内: 内覧の件数（枠の長さ）と内覧する物件の場所（前後の予定との間の空け方）も渡せる。無ければ 1件・場所は不明
  opts: { ignoreHoldsForConversationId?: string | null; viewingCount?: number | null; viewingPlace?: string | null } = {},
): Promise<{
  days: CalendarDayResult[];
  infoString: string; // AIに渡す文字列
  baseCount: number; // 基準の日（本日から順・直近の空いている3日まで）の数。days のこれより後ろはお客様の希望日などの追加の日
}> {
  const now = jstParts();
  const todayUtc = Date.UTC(now.y, now.m - 1, now.d);
  // 2026-10-02 竹内「直近は基本3候補いれる。2候補でも大丈夫やけど、候補多く出すため直近3候補が基本」:
  //   旧は本日・明日・明後日の3日に固定 → 本日の枠が過ぎた・埋まった日は候補が2つ以下だった。1週間見て、空いている日を前から3日（viewing-candidates.ts）
  const baseYmds = Array.from({ length: VIEWING_LOOKAHEAD_DAYS }, (_, i) => jstYmd(todayUtc + i * DAY_MS - 9 * 3600 * 1000));
  // 2026-09-19 竹内（a🤫 事例・退去予定）: 追加日は**呼び出し側が並べた順**で先着を採る（お客様の希望日を先に渡す）。
  //   以前は日付順に並べてから先頭5日を採っていたので、退去予定日以降の日を足すと希望日が押し出されていた。
  //   採ってから日付順に並べ直す（画面の並びと「本日・明日・明後日」のラベルは index で決まるため）
  const extras = [...new Set(extraYmds.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && s > baseYmds[baseYmds.length - 1]))]
    .slice(0, MAX_EXTRA_DAYS)
    .sort();
  const allYmds = [...baseYmds, ...extras];
  const fromDate = allYmds[0];
  const toDate   = allYmds[allYmds.length - 1];

  const startISO = new Date(`${fromDate}T00:00:00+09:00`).toISOString();
  const endISO   = new Date(`${toDate}T23:59:59+09:00`).toISOString();

  const [evResult, tasksRaw] = await Promise.all([
    supabase
      .from("calendar_events")
      .select("start_at, end_at, event_type, title, all_day, notes, conversation_id")
      .gte("start_at", startISO)
      .lte("start_at", endISO)
      .order("start_at"),
    fetch(`/api/daily-tasks?from=${fromDate}&to=${toDate}`).then(r => r.ok ? r.json() : []),
  ]);

  const allEvents = (evResult.data || []) as Array<{
    start_at: string; end_at: string | null; event_type: string; title: string; all_day: boolean; notes: string | null; conversation_id: string | null;
  }>;
  // そのお客様自身の時間確保は、そのお客様への候補の計算では外す（同じ時間をもう一度出せる）
  const events = opts.ignoreHoldsForConversationId
    ? allEvents.filter((ev) => !(ev.conversation_id === opts.ignoreHoldsForConversationId && isViewingHoldNotes(ev.notes)))
    : allEvents;
  const tasks = (Array.isArray(tasksRaw) ? tasksRaw : []) as Array<{
    content: string; date: string; time: string; end_time: string; done: boolean;
  }>;

  const resultDays: CalendarDayResult[] = [];
  const infoLines: Array<[number, string]> = [];

  // 現在時刻（分・日本時間）- 今日のスロットフィルタリングに使用
  const nowMin = now.hour * 60 + now.minute;
  const jstMin = (iso: string) => { const p = jstParts(iso); return p.hour * 60 + p.minute; };

  for (let i = 0; i < allYmds.length; i++) {
    const dateKey = allYmds[i];
    const [yy, mo, dd] = dateKey.split("-").map(Number);
    const month = mo;
    const date  = dd;
    const wd    = WEEKDAYS_JP[new Date(Date.UTC(yy, mo - 1, dd)).getUTCDay()];
    // 2026-09-19 竹内（まりあ事例）「明後日じゃないのに明後日と出ている」:
    //   算数は合っている（9/19(土)の2日後は9/21(月)）が、**「明後日」はうちの言い方ではない**。
    //   実送信365日の内覧日程の案内188通で「明後日 M/D」は18通（9.6%）＝90%は日付だけで書いている。
    //   このまりあさんの回も、スタッフは「明後日」だけを消して「本日」は残して送っている。
    //   さらに候補日が飛んでいる時（9/20 が満で 9/19・9/21・9/22 が並ぶ）は、
    //   相対の語が入ると連続した日程に見えて紛らわしい。
    //   → **本日・明日だけ残し、明後日は使わない**（日付と曜日は残るので情報は減らない）。
    const label_prefix = i === 0 ? "本日" : i === 1 ? "明日" : "";
    const label = label_prefix ? `${label_prefix} ${month}/${date}(${wd})` : `${month}/${date}(${wd})`;
    const shortLabel = label_prefix ? `${label_prefix}(${month}/${date}${wd})` : `${month}/${date}(${wd})`;

    const busy: SlotBusy[] = [];

    for (const ev of events) {
      if (jstYmd(ev.start_at) !== dateKey) continue;
      if (ev.all_day) {
        // 「定休・休業・休み・休日・お休み」などの休業系のみ終日ブロック
        // それ以外の全日イベント（会議メモ・リマインダー等）は時間をブロックしない
        const isClosedDay = /定休|休業|休み|休日|お休み|closed|holiday/i.test(ev.title || "") || ev.event_type === "holiday";
        if (isClosedDay) {
          busy.push({ start: 0, end: 24 * 60 });
        }
      } else {
        const sm = jstMin(ev.start_at);
        const em = ev.end_at ? jstMin(ev.end_at) : sm + 60;
        // 場所はメモ（住所・物件名）から読む。決まった内覧（物件・住所のある予定）だけ「出かける予定」＝場所が読めなければ長めに空ける
        busy.push({ start: sm, end: Math.max(em, sm), text: ev.notes, outing: isOutingViewingNotes(ev.event_type, ev.notes) });
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
        busy.push({ start: sm, end: Math.max(em, sm), text: t.content });
      }
    }

    // 枠の決まりは planDaySlots（11:00〜18:30 の中・件数で長さ・予定との間は場所で空ける・長い空きは切る）。
    //   当日は今から1時間後以降に始まる枠だけ（旧: 終わりが今より後なら出していた＝始まりが過ぎた枠も出ていた）
    const slots      = planDaySlots({ busy, count: opts.viewingCount, place: opts.viewingPlace, notBeforeMin: i === 0 ? nowMin : null }).slots;
    const noEvents   = busy.length === 0;
    const fullyBooked = !noEvents && slots.length === 0;
    // 予定の無い日は 13:00 から（planDaySlots が予定なしの日をそう扱う）。出すのは2つまで（旧の既定 13:00〜16:00 / 16:00〜18:30 と同じ数）
    const defaultSlots = noEvents ? slots.slice(0, 2) : [];

    if (noEvents && defaultSlots.length === 0) {
      // 今日・予定なし・全スロット時間切れ → 案内不可扱い
      resultDays.push({ label, ymd: dateKey, slots: [], fullyBooked: true, noEvents: true });
    } else if (noEvents) {
      infoLines.push([i, `${shortLabel} ${defaultSlots.join(" / ")}`]);
      resultDays.push({ label, ymd: dateKey, slots: defaultSlots, fullyBooked: false, noEvents: true });
    } else if (fullyBooked) {
      // 案内不可の日はinfoLinesに含めない（AIに渡さない）
      resultDays.push({ label, ymd: dateKey, slots: [], fullyBooked: true, noEvents: false });
    } else {
      infoLines.push([i, `${shortLabel} ${slots.join(" / ")}`]);
      resultDays.push({ label, ymd: dateKey, slots, fullyBooked: false, noEvents: false });
    }
  }

  // 基準の日は「3つ目の空いている日」まで（少なくとも本日・明日・明後日）。お客様の希望日（extraYmds）は基準の日の中にあっても残す（後ろへ回す）
  const baseCount = baseYmds.length;
  const keepBase = baseDaysToKeep(resultDays, baseCount);
  const requested = new Set(extraYmds);
  const keptIdx = resultDays.map((_, i) => i).filter((i) => i < keepBase || i >= baseCount || requested.has(resultDays[i].ymd));
  const order = [...keptIdx.filter((i) => i < keepBase), ...keptIdx.filter((i) => i >= keepBase)];
  const lineOf = new Map(infoLines);
  return {
    days: order.map((i) => resultDays[i]),
    infoString: order.map((i) => lineOf.get(i)).filter((x): x is string => !!x).join("\n"),
    baseCount: keepBase,
  };
}
