// scripts/lib/brain-exam-dates.ts — ブレインの試験で、場面の日付のずらしを「お客様の日だけの言い方」と正解（依頼の要点・言ってはいけない事）にも当てる（純関数）
//
// 2026-10-09 竹内さん「試験を90%超えたい」→ 試験の穴（audit-brain-exam-failures.ts）:
//   ① q060: 会話の「10/31」は 11/21 にずれるのに、正解の要点の「10/31」はずれず、6回とも依頼が✕（試験の食い違い）
//   ② q049: スタッフの「9/18」は 10/16 にずれるのに、お客様の「18の南船場の内覧」（日だけ）はずれず、決まった内覧とつながらない
// shiftDatesInText（M/D・M月D日）に加えて、日だけの言い方（「18日」「18の〇〇の内覧」）を、その文の時点から見た次のその日として読んでずらす。
//   期間（10日程・3日間・5日以内・2日前・1日分 等）は触らない。URL の中は触らない。
import { shiftDatesInText } from "./scenario-date-shift";

const DAY_MS = 86_400_000;
const jstParts = (ms: number) => { const d = new Date(ms + 9 * 3600_000); return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate() }; };

/** 日だけの d を、基準の時刻（refMs・その文の時刻）から見た日付として読み、days 日ずらした日を返す */
export function shiftBareDay(d: number, refMs: number, days: number): number | null {
  if (d < 1 || d > 31) return null;
  const r = jstParts(refMs);
  // 基準の日より3日以上前の日は来月の事（「18日」を 9/27 に言えば 10/18）
  let y = r.y, mo = r.mo;
  if (d < r.d - 3) { mo += 1; if (mo > 11) { mo = 0; y += 1; } }
  const t = Date.UTC(y, mo, d);
  if (new Date(t).getUTCDate() !== d) return null; // 31日の無い月
  return new Date(t + days * DAY_MS).getUTCDate();
}

// 日だけ: 「18日」（期間の言い方は外す）／「18の〇〇の内覧」（内覧・案内・時刻が近くにある時だけ）
const BARE_DAY_RE = /(?<![0-9０-９/／月第毎.:：])(\d{1,2})日(?!\d|程|間|以内|以上|前|後|分|ほど|くらい|ぐらい|位|未満|おき|毎|ごと|連続|割|当日)/g;
const BARE_NO_RE = /(?<![0-9０-９/／月第毎.:：])(\d{1,2})の(?=[^。\n]{0,10}(?:内覧|内見|見学|案内|午前|午後|\d{1,2}時))/g;

/** 文の中の日付を days 日ずらす（M/D・M月D日は shiftDatesInText、日だけの言い方はここ）。refMs はその文の時刻 */
export function shiftExamText(text: string, days: number, year: number, refMs: number): string {
  if (!days || !text) return text;
  const s = shiftDatesInText(text, days, year);
  return s.split(/(https?:\/\/\S+)/).map((part, i) => {
    if (i % 2 === 1) return part;
    // shiftDatesInText がずらした「M月D日」の D は月の後ろなので BARE_DAY_RE の後読み（月）で外れる
    return part
      .replace(BARE_DAY_RE, (all, d: string) => { const n = shiftBareDay(Number(d), refMs, days); return n ? `${n}日` : all; })
      .replace(BARE_NO_RE, (all, d: string) => { const n = shiftBareDay(Number(d), refMs, days); return n ? `${n}の` : all; });
  }).join("");
}
