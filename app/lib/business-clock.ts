// app/lib/business-clock.ts — 暦と営業時間の計算を1か所に（純関数・DB/LLM なし）。ブレインと文の両方に毎回同じ形で渡す
//
// 2026-11-03 作業員6（竹内さん KB P1「細かい土台を8つ入れる」⑥）。日付・曜日は jst-date.ts（既存の芯）を使い、その上に会社の時刻の決まりを重ねる。
//   今あちこちにある同じ計算（getJSTHour が generate-reply・generate-reply-patterns・cron 3本に別々・18時の管理会社の線・19時の電話・21時の弊社の終わり）は
//   一覧にしてから、悪化0を確かめて1つずつここに寄せる（今はまだ誰も呼んでいない＝本番の動きは変わらない）。
//   決まり: 電話は19時まで（company-facts・竹内さん 10/02）／管理会社しか答えられない確認は18時以降は明日（mgmt-hours-split）／弊社の終わり 21時（COMPANY_CLOSE_HOUR）。
//   「M/D」の書き方（「11/2日」と書かない）。始まりの時刻は決まっていない＝出さない。定休日は竹内さんの確認待ち（決まるまで null）。
//   祝日は静的なデータなので手で持つ（feedback_static_vs_dynamic_db・内閣府の一覧・毎年足す）。
// テスト: app/lib/__tests__/business-clock.test.ts
import { jstParts, WEEKDAYS_JA, JST_OFFSET_MS } from "./jst-date";
import { COMPANY_CLOSE_HOUR } from "./mgmt-hours-split";

export const PHONE_LAST_HOUR = 19;
export const MGMT_CLOSE_HOUR = 18;
/** 日本の祝日（振替・国民の休日を含む）2026〜2027 */
export const JP_HOLIDAYS: Readonly<Record<string, string>> = {
  "2026-01-01": "元日", "2026-01-12": "成人の日", "2026-02-11": "建国記念の日", "2026-02-23": "天皇誕生日", "2026-03-20": "春分の日",
  "2026-04-29": "昭和の日", "2026-05-03": "憲法記念日", "2026-05-04": "みどりの日", "2026-05-05": "こどもの日", "2026-05-06": "振替休日",
  "2026-07-20": "海の日", "2026-08-11": "山の日", "2026-09-21": "敬老の日", "2026-09-22": "国民の休日", "2026-09-23": "秋分の日",
  "2026-10-12": "スポーツの日", "2026-11-03": "文化の日", "2026-11-23": "勤労感謝の日",
  "2027-01-01": "元日", "2027-01-11": "成人の日", "2027-02-11": "建国記念の日", "2027-02-23": "天皇誕生日", "2027-03-21": "春分の日", "2027-03-22": "振替休日",
  "2027-04-29": "昭和の日", "2027-05-03": "憲法記念日", "2027-05-04": "みどりの日", "2027-05-05": "こどもの日", "2027-07-19": "海の日", "2027-08-11": "山の日",
  "2027-09-20": "敬老の日", "2027-09-23": "秋分の日", "2027-10-11": "スポーツの日", "2027-11-03": "文化の日", "2027-11-23": "勤労感謝の日",
};
/** 定休日（曜日 0=日…6=土）。竹内さんの確認待ち＝決まるまで空 */
export const CLOSED_WEEKDAYS: readonly number[] = [];

export type DayInfo = { ymd: string; md: string; dow: string; holiday: string | null; closed: boolean };
export type BusinessClock = {
  hour: number; minute: number;
  today: DayInfo; tomorrow: DayInfo;
  /** 電話は19時まで */ phoneOk: boolean;
  /** 管理会社にしか答えられない確認は18時以降は明日 */ mgmtAfterHours: boolean;
  /** 弊社の終わり（21時）を過ぎたか */ afterClose: boolean;
};
const pad = (n: number) => String(n).padStart(2, "0");
function dayInfo(ms: number): DayInfo {
  const p = jstParts(ms);
  const ymd = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  return { ymd, md: `${p.m}/${p.d}`, dow: WEEKDAYS_JA[p.dow], holiday: JP_HOLIDAYS[ymd] ?? null, closed: CLOSED_WEEKDAYS.includes(p.dow) };
}
export function businessClock(nowMs: number = Date.now()): BusinessClock {
  const p = jstParts(nowMs);
  return {
    hour: p.hour, minute: p.minute, today: dayInfo(nowMs), tomorrow: dayInfo(nowMs + 86400_000),
    phoneOk: p.hour < PHONE_LAST_HOUR, mgmtAfterHours: p.hour >= MGMT_CLOSE_HOUR, afterClose: p.hour >= COMPANY_CLOSE_HOUR,
  };
}
/** ブレインと書き手に同じ形で渡す1行 */
export function businessClockLine(c: BusinessClock): string {
  const day = (d: DayInfo) => `${d.md}（${d.dow}）${d.holiday ? `・祝日（${d.holiday}）` : ""}${d.closed ? "・定休日" : ""}`;
  return `【今の時刻】今日 ${day(c.today)} ${c.hour}:${pad(c.minute)}／明日 ${day(c.tomorrow)}／電話は19時まで（${c.phoneOk ? "今は可" : "今日はもう終わり"}）／管理会社への確認は${c.mgmtAfterHours ? "営業時間外＝明日" : "今日できる"}。日付は「M/D」で書く（「11/2日」と書かない）。`;
}
/** 「11/2日」→「11/2」（日付の書き方の網） */
export function fixMdNichi(text: string): string {
  return String(text ?? "").replace(/(?<![0-9０-９])([0-9０-９]{1,2})[\/／]([0-9０-９]{1,2})日/g, "$1/$2");
}
export { JST_OFFSET_MS };
