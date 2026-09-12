// app/lib/jst-date.ts
// 2026-09-12 竹内方針D（統合設計 §4）: 日本時間（Asia/Tokyo）の日付・曜日の計算をこのファイルの関数だけで行う。
//   ・「+9h してから getUTC*」の1通りに統一する（サーバー＝UTC でもローカル PC＝JST でも同じ結果。
//     +9h した Date にローカル getter を使う書き方は、ローカル実行で +18h になるので使わない）
//   ・曜日は日付を正として決める（weekdayForMonthDay）。生成側は曜日表（weekdayTable）をプロンプトに渡して LLM に曜日を計算させず、
//     後処理（typo-check の TYPO_WEEKDAY_MISMATCH）と few-shot の衛生（example-hygiene）は fixDateWeekdays で同じ判定を使う
//   ・実データ: 下書きの曜日の食い違い 26/331件のうち 24件は前年（2025年）の暦の曜日（LLM が自分で曜日を計算していた）
//   依存ゼロ（他の app/lib/* を import しない）。

export const JST_OFFSET_MS = 9 * 3600 * 1000;
const DAY_MS = 86_400_000;
export const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

export type JstParts = { y: number; m: number; d: number; hour: number; minute: number; /** 0=日 … 6=土 */ dow: number };

function toMs(input: string | number | Date | null | undefined): number {
  if (input == null) return NaN;
  if (typeof input === "number") return input;
  if (input instanceof Date) return input.getTime();
  return Date.parse(input);
}

/** 日本時間の年月日・時分・曜日（ms 省略時は現在） */
export function jstParts(input: string | number | Date = Date.now()): JstParts {
  const j = new Date(toMs(input) + JST_OFFSET_MS);
  return { y: j.getUTCFullYear(), m: j.getUTCMonth() + 1, d: j.getUTCDate(), hour: j.getUTCHours(), minute: j.getUTCMinutes(), dow: j.getUTCDay() };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 'YYYY-MM-DD'（日本時間） */
export function jstYmd(input: string | number | Date = Date.now()): string {
  const p = jstParts(input);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/** 'M/D'（日本時間）。不正な日時は "" */
export function jstMD(input: string | number | Date | null | undefined): string {
  const t = toMs(input);
  if (!Number.isFinite(t)) return "";
  const p = jstParts(t);
  return `${p.m}/${p.d}`;
}

/** 'M/D HH:mm'（日本時間）。不正な日時は "" */
export function jstMDHm(input: string | number | Date | null | undefined): string {
  const t = toMs(input);
  if (!Number.isFinite(t)) return "";
  const p = jstParts(t);
  return `${p.m}/${p.d} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** 'M月D日（曜）'（日本時間） */
export function jstDateLabel(input: string | number | Date = Date.now()): string {
  const p = jstParts(input);
  return `${p.m}月${p.d}日（${WEEKDAYS_JA[p.dow]}）`;
}

/** 'YYYY/M/D（曜）'（日本時間） */
export function jstYmdWeekday(input: string | number | Date = Date.now()): string {
  const p = jstParts(input);
  return `${p.y}/${p.m}/${p.d}（${WEEKDAYS_JA[p.dow]}）`;
}

/** 日本時間の当日 0:00 の UTC ms */
export function jstDayStartMs(input: string | number | Date = Date.now()): number {
  const p = jstParts(input);
  return Date.UTC(p.y, p.m - 1, p.d) - JST_OFFSET_MS;
}

/** その日時が属する週（月曜始まり・日本時間）の月曜の 'YYYY-MM-DD' */
export function jstWeekMondayYmd(input: string | number | Date = Date.now()): string {
  const p = jstParts(input);
  const back = p.dow === 0 ? 6 : p.dow - 1;
  const mon = new Date(Date.UTC(p.y, p.m - 1, p.d) - back * DAY_MS);
  return `${mon.getUTCFullYear()}-${pad2(mon.getUTCMonth() + 1)}-${pad2(mon.getUTCDate())}`;
}

/**
 * 「M月D日」の曜日（日本時間の現在日±約6か月で年を推定。日付を正とする）。
 * 年は前年・今年・翌年のうち今日に最も近い日（184日以内）。無効な日付（2/30 等）や遠すぎる日付は null。
 */
export function weekdayForMonthDay(month: number, day: number, nowMs: number = Date.now()): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const now = jstParts(nowMs);
  const today = Date.UTC(now.y, now.m - 1, now.d);
  let best: { diff: number; wd: number } | null = null;
  for (const y of [now.y - 1, now.y, now.y + 1]) {
    const t = Date.UTC(y, month - 1, day);
    const d = new Date(t);
    if (d.getUTCMonth() !== month - 1) continue; // 2/30 等
    const diff = Math.abs(t - today);
    if (diff > 184 * DAY_MS) continue;
    if (!best || diff < best.diff) best = { diff, wd: d.getUTCDay() };
  }
  return best ? WEEKDAYS_JA[best.wd] : null;
}

/** 今日から days 日分の曜日表（日本時間）。例: '9/12（土）・9/13（日）・…' */
export function weekdayTable(nowMs: number = Date.now(), days = 14): string {
  const out: string[] = [];
  const start = jstParts(nowMs);
  const base = Date.UTC(start.y, start.m - 1, start.d);
  for (let i = 0; i < days; i++) {
    const d = new Date(base + i * DAY_MS);
    out.push(`${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAYS_JA[d.getUTCDay()]}）`);
  }
  return out.join("・");
}

const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** 「M/D（曜）」「M月D日（曜）」「M月D日(曜日)」 */
export const DATE_WEEKDAY_RE = /([0-9０-９]{1,2})(?:[\/／]|月)([0-9０-９]{1,2})日?\s*[（(]([日月火水木金土])(?:曜日?)?[）)]/g;

/**
 * DATE_WEEKDAY_RE の1件の一致を、日付を正として曜日だけ直した文字列にする。
 * 曜日が合っている／日付として無効な時は原文のまま返す。
 */
export function correctDateWeekdayMatch(whole: string, monthStr: string, dayStr: string, weekday: string, nowMs: number = Date.now()): string {
  const wd = weekdayForMonthDay(Number(toHalf(monthStr)), Number(toHalf(dayStr)), nowMs);
  if (!wd || wd === weekday) return whole;
  return whole.replace(/[（(][日月火水木金土]/, (s) => s[0] + wd);
}

/**
 * 文中の「日付（曜）」の曜日を日付を正として直す（nowMs はその文を書いた時点。年の推定に使う）。
 * mode='strip' は食い違う曜日を付け替えずに外す（書いた時点が分からず年を確定できない文用。日付は残し、誤った曜日を新たに作らない）
 */
export function fixDateWeekdays(text: string, nowMs: number = Date.now(), mode: "replace" | "strip" = "replace"): { text: string; applied: string[] } {
  const applied: string[] = [];
  const re = new RegExp(DATE_WEEKDAY_RE.source, "g");
  const out = text.replace(re, (whole: string, mo: string, da: string, wd: string) => {
    const corrected = correctDateWeekdayMatch(whole, mo, da, wd, nowMs);
    if (corrected === whole) return whole;
    const fixed = mode === "strip" ? whole.replace(/\s*[（(][日月火水木金土](?:曜日?)?[）)]$/, "") : corrected;
    applied.push(`${whole}→${fixed}`);
    return fixed;
  });
  return { text: out, applied };
}
