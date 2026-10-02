// app/lib/viewing-candidates.ts
// こちらから出す内覧の候補日は「直近の空いている日を3つ」（純関数・DB も fetch も持たない）。
//
// 2026-10-02 竹内さん（YUMA の AIX【内覧調整】「10/3(土) 11:00〜13:00／10/4(日) 14:00〜16:00にてご案内可能です」＝2つを見て）:
//   「直近は基本3候補いれる。2候補でも大丈夫やけど、候補多く出すため直近3候補が基本」。
// 原因（コード）: 候補の日は「本日・明日・明後日」の3日に固定（calendarSlots.fetchCalendarSlots の baseYmds）で、
//   本日は「今から1時間後より後に始まる枠」しか出さない（planDaySlots）ので、昼過ぎ以降・本日が埋まっている日は必ず2つ以下になっていた。
//   画面（AixModal）の既定も「直近3日のうち空きのある日」＝同じく2つ。テストの道具の固定の候補（customer-sim-material.fixedViewingSlots）も2つ。
//   実送信（180日・こちらから日にちを出した54件）は 2日→2枠 27・3日→3枠 25（viewing-slots.ts の記録）。竹内さんの決まりで3つを基本にする。
// 決まり: 本日から順に見て、空き枠のある日を先頭から3日（無ければある分＝2つでもよい）。見る日数は最大 VIEWING_LOOKAHEAD_DAYS。
//   1日に出す枠は1つ（viewing-slots.limitSlotsPerDay・こちらから日にちを出す時）。枠の長さ・11:00〜18:30・移動の空け方は viewing-slot-plan.ts のまま。

/** こちらから出す候補の数（基本） */
export const VIEWING_CANDIDATE_DAYS = 3;
/** 候補を探す日数（本日を含む）。予定が詰まっていても3つ見つかるよう1週間見る */
export const VIEWING_LOOKAHEAD_DAYS = 7;

export type CandidateDay = { fullyBooked: boolean; slots?: ReadonlyArray<string> };

/** 空き枠のある日か */
export function isBookable(d: CandidateDay): boolean {
  return !d.fullyBooked && (d.slots === undefined || d.slots.length > 0);
}

/**
 * 先頭から空き枠のある日を n 日選ぶ（日の並びは本日から順）。返すのは選んだ日の index（昇順）。
 * baseCount … 前から何日が「基準の日」か（その後ろはお客様の希望日などの追加の日＝ここでは選ばない）
 */
export function nearestBookableDays(days: ReadonlyArray<CandidateDay>, n: number = VIEWING_CANDIDATE_DAYS, baseCount: number = days.length): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.min(baseCount, days.length) && out.length < n; i++) if (isBookable(days[i])) out.push(i);
  return out;
}

/**
 * 基準の日を何日残すか（画面に並べる日・AI に渡す日）: 3つ目の空いている日まで。3つ見つからなければ基準の日を全部。
 * 少なくとも本日・明日・明後日の3日は残す（旧の並び・ラベル「本日／明日」を変えない）
 */
export function baseDaysToKeep(days: ReadonlyArray<CandidateDay>, baseCount: number, n: number = VIEWING_CANDIDATE_DAYS): number {
  const picked = nearestBookableDays(days, n, baseCount);
  if (picked.length < n) return Math.min(baseCount, days.length);
  return Math.max(Math.min(3, baseCount), picked[picked.length - 1] + 1);
}
