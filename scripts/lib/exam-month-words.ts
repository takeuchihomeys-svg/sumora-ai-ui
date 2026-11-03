// scripts/lib/exam-month-words.ts — 試験の時計の弱さの見張り（2026-11-03 指揮役）: 月だけの言い方（日付の無い「〇月」）がある問題を見つける
//   試験は M/D の日付を今日へずらすが、月だけの言い方はずらさない → 入居の時期（far_move_in・monthClockNowIso で直した）と支払いの時期（payment-timing・未対応）で読みがずれる。
//   新しい問題にこの言い方が入ったら、毎晩の正解の組の道具（exam-answer-sets.ts）が知らせる（noDateShift を付けるか決める材料）
const MONTH = String.raw`(\d{1,2}|[０-９]{1,2}|来|再来)月(?!\s*[\d０-９]{1,2}\s*日)`;
export const PAY_MONTH_RE = new RegExp(`${MONTH}[^。\n"]{0,20}(給料|給与|入金|ボーナス|支払|振込|お金が入)|(給料|給与|入金|ボーナス|支払|振込)[^。\n"]{0,20}${MONTH}`);
export const MOVE_IN_MONTH_RE = new RegExp(`${MONTH}[^。\n"]{0,12}(入居|引っ越|引越|住み|退去|更新)|(入居|引っ越|引越|住み替え|退去|更新)[^。\n"]{0,12}${MONTH}`);
export function monthWordKinds(text: string): Array<"支払い" | "入居"> {
  const out: Array<"支払い" | "入居"> = [];
  if (PAY_MONTH_RE.test(text)) out.push("支払い");
  if (MOVE_IN_MONTH_RE.test(text)) out.push("入居");
  return out;
}
