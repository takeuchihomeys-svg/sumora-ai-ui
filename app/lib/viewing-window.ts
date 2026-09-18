// app/lib/viewing-window.ts
// 内覧できる日の窓（AIX【内覧へ！】の「内覧可能日時」）。純関数・DB 依存なし。
//
// 2026-09-19 竹内（a🤫 事例・画面の2点）:
//   ①「お客さんから9月20日内覧希望と言われていないのに、ここ9月20日と出てしまっている。
//      ここは、お客さんからの日付指定が合った場合のみにする」
//   ②「退去予定日入れると、その退去予定日以降で内覧する形となるので、内覧可能日時は
//      退去予定日以降のところから、順に空いている日付いれる形とする」
//
// ②の背景: 画面は常に「本日・明日・明後日」の3日を初期チェックしていた。退去予定日が 9/27 の物件では
//   その3日は全部**内覧できない日**で、送信時のフィルタ（退去翌日より前を除外）に全部落ちて候補ゼロになっていた。
//   ＝「見られない日を出して、出口で捨てる」形。見られる日を最初から出す形に変える。
//
// 退去日を読む所は vacating-notice.viewableFromVacancyYmd の1つだけにする（四者同名）。
import { viewableFromVacancyYmd } from "./vacating-notice";

const DAY_MS = 86_400_000;

/** 内覧できる最初の日（退去日の翌日・"YYYY-MM-DD"）。読めなければ null */
export function viewableFromYmd(vacancyDateRaw: string, nowMs: number = Date.now()): string | null {
  return viewableFromVacancyYmd(vacancyDateRaw, nowMs);
}

/**
 * カレンダーに追加で取りに行く日（内覧できる最初の日から連続 count 日）。
 * 退去日が読めない・過ぎている（もう見られる）時は空配列＝いつもどおり直近3日で足りる。
 * fetchCalendarSlots 側が「基準の3日より後」だけを採るので、重なる日を渡しても害はない。
 */
export function vacancyExtraYmds(vacancyDateRaw: string, nowMs: number = Date.now(), count = 6): string[] {
  const from = viewableFromYmd(vacancyDateRaw, nowMs);
  if (!from) return [];
  const base = Date.parse(`${from}T00:00:00Z`);
  if (!Number.isFinite(base)) return [];
  const out: string[] = [];
  const p = (n: number) => String(n).padStart(2, "0");
  for (let i = 0; i < Math.max(0, count); i++) {
    const d = new Date(base + i * DAY_MS);
    out.push(`${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`);
  }
  return out;
}

/** 候補の行（「9/28(月) 12:00〜14:00」「7/1日 11:00〜16:00」）。日付＋時間だけの行を候補とみなす */
const SLOT_LINE_RE = /^[\s・]*(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?\s*(?:[（(][日月火水木金土][）)])?[\s、,]*\d{1,2}:\d{2}\s*[〜~\-]/;

/**
 * 生成文から「内覧できない日（退去前）の候補の行」を落とす。
 * 2026-09-19 竹内「AIXの内覧調整のところ会話を合わせるボタンつくる」の出口。
 * 落とすのは**日付＋時間だけの行**に限る（本文の中の日付には触らない＝誤削除を避ける）。
 * 年は解禁日の年で解決する（候補は解禁日の近くにしか出ない）。
 */
export function stripSlotLinesBeforeViewable(text: string, fromYmd: string | null): { text: string; removed: string[] } {
  const removed: string[] = [];
  if (!fromYmd || !text) return { text: text ?? "", removed };
  const fromYear = Number(fromYmd.slice(0, 4));
  const p = (n: number) => String(n).padStart(2, "0");
  const kept = text.split("\n").filter((line) => {
    const m = SLOT_LINE_RE.exec(line);
    if (!m) return true;
    const month = Number(m[1]);
    const day = Number(m[2]);
    // 解禁日の月より小さい月は翌年（12月解禁 → 1月の候補）
    const year = month < Number(fromYmd.slice(5, 7)) - 6 ? fromYear + 1 : fromYear;
    if (!isBeforeViewable(`${year}-${p(month)}-${p(day)}`, fromYmd)) return true;
    removed.push(line.trim());
    return false;
  });
  if (removed.length === 0) return { text, removed };
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

/** その日は内覧できない（退去前）か。解禁日が無い時は常に false（＝いつもどおり） */
export function isBeforeViewable(dayYmd: string, fromYmd: string | null): boolean {
  if (!fromYmd || !dayYmd) return false;
  return dayYmd < fromYmd;
}

/**
 * 退去予定物件の「内覧可能日時」の初期チェック。
 * 内覧できる最初の日から順に、**空いている日**だけを count 日ぶん ON にする（予定で埋まった日は飛ばす）。
 * 解禁日が読めない時は null を返し、呼び出し側は従来どおりの初期値（直近3日）を使う。
 */
export function resolveVacancySlotEnabled(
  days: ReadonlyArray<{ ymd: string; fullyBooked: boolean }>,
  fromYmd: string | null,
  count = 3,
): boolean[] | null {
  if (!fromYmd) return null;
  let taken = 0;
  return days.map((d) => {
    if (isBeforeViewable(d.ymd, fromYmd)) return false; // 退去前は出さない
    if (d.fullyBooked || taken >= count) return false;  // 予定で埋まった日は飛ばす
    taken++;
    return true;
  });
}
