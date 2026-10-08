// app/lib/viewing-day-greeting.ts — 確定した内覧の当日は AIX【内覧挨拶→内覧前】を出す番（純関数・LLM なし）
//
// 2026-10-08 竹内さん（10巡目）: 「挨拶なんで入れるかは、スタッフが内覧をちゃんとあると思うために入れている。忘れないため」
//   ＝内覧挨拶（内覧前・当日）の目的はお客様が内覧を忘れない・確実に来てもらうための確認（リマインド）。
//   待ち合わせ場所の AIX で確定した内覧がある日は、お客様の発言を待たずに当日（内覧の前）に内覧挨拶を出す番。既に送っていれば出さない・キャンセル済みは出さない
//   （済んだ内覧・キャンセルは行動台帳の viewingAppointment が null にする）。お客様の発言の番でも「今日は確定した内覧の日で、まだ挨拶を送っていない」なら優先の候補。
//   ⚠ 内覧挨拶はピッカーが文を入力欄に入れ普通の送信で送るので、押下の記録（aix_usage_logs）は 10/07 まで残らなかった → 送ったかは今日のこちらの文でも見る。
//   戻す: VIEWING_DAY_GREETING=off

/** 今日こちらが送った「内覧の当日の挨拶・送り出し」（本日…よろしく・お気をつけて・お待ちしております・本日…ご案内） */
export const VIEWING_DAY_GREETED_RE = /お気をつけて|お待ちしております|(?:本日|今日)[^\n]{0,30}(?:よろしくお願い|宜しくお願い|ご案内させて|ご案内いたし|ご案内致し|何卒)/;

const JST = 9 * 3600_000;
const jstDay = (ms: number) => Math.floor((ms + JST) / 86_400_000);

export type ViewingDayGreetingInput = {
  /** 行動台帳の viewingAppointment.day（確定した内覧が今日か）。済んだ・キャンセルの内覧は台帳が null にする */
  appointmentDay: "today" | "tomorrow" | "later" | "unknown" | null | undefined;
  /** こちらの文（時刻つき） */
  staffMessages: ReadonlyArray<{ text: string | null; createdAt: string }>;
  /** 今日押した AIX の種類 */
  aixTypesToday?: ReadonlyArray<string>;
  nowMs: number;
  env?: Record<string, string | undefined>;
};

/** 今日が確定した内覧の日で、まだ当日の挨拶（内覧挨拶・送り出し）を送っていないか */
export function viewingDayGreetingDue(i: ViewingDayGreetingInput): boolean {
  const env = i.env ?? (typeof process !== "undefined" ? process.env : {});
  if ((env.VIEWING_DAY_GREETING ?? "").toLowerCase() === "off") return false;
  if (i.appointmentDay !== "today") return false;
  if ((i.aixTypesToday ?? []).includes("greeting_viewing")) return false;
  const today = jstDay(i.nowMs);
  return !i.staffMessages.some((m) => jstDay(Date.parse(m.createdAt)) === today && VIEWING_DAY_GREETED_RE.test(String(m.text ?? "").normalize("NFKC")));
}
export const VIEWING_DAY_GREETING_SOURCE = "rule:viewing_day_greeting_before";
