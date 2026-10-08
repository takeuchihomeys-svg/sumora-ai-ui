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

// ─── 朝の要対応（2026-10-08 竹内さん「作る」）───
// お客様の発言の無い朝でも、待ち合わせ場所の AIX で確定した内覧の当日なら、内覧の前に AIX【内覧挨拶→内覧前】を
// AIX要対応（売上番長グループの通知）に立てる。cron /api/cron/viewing-morning-greeting（JST 9:15）が会話ごとにこの1関数で決める。
//   ・確定＝行動台帳の viewingAppointment（AIX【待ち合わせ場所】・待ち合わせの本文・内覧後のお礼の前）が今日 かつ 内覧の流れ（viewing-flow）が confirmed
//     （取りやめ「キャンセルで」の後は流れが none・理由 customer_cancelled_after_confirm になる＝flowCancelled で止める）
//   ・今日すでに当日の挨拶（本日…よろしく・お気をつけて・内覧挨拶の AIX）を送った → 立てない（viewingDayGreetingDue と同じ線）
//   ・内覧の時刻まで MORNING_MIN_LEAD_MIN 分を切っている → 立てない（もう間に合わない・スタッフは現地へ向かう）
//   ・申込以降 → 立てない（今の対象外）
//   ・同じ会話に別の AIX要対応が未完了 → 立てない（1会話1件・ブレインの依頼を上書きしない）。同じ内覧挨拶なら何もしない
//   戻す: VIEWING_MORNING_GREETING=off（VIEWING_DAY_GREETING=off でも止まる）
export const MORNING_MIN_LEAD_MIN = 30;
export const VIEWING_MORNING_GREETING_PATTERN = "before";
export type MorningGreetingInput = ViewingDayGreetingInput & {
  /** 内覧の流れが確定（confirmed）か。流れが読めない時は null（台帳の待ち合わせだけで決める） */
  flowConfirmed: boolean | null;
  /** 内覧の流れの理由が取りやめ（customer_cancelled*）。confirmed は台帳の待ち合わせが残る限り true のままなので別に見る */
  flowCancelled?: boolean;
  /** 待ち合わせの開始時刻「13:00」（無ければ null＝時刻で止めない） */
  appointmentTime: string | null;
  postApply: boolean;
  /** 同じ会話の未完了の AIX要対応 */
  pending: { action: string; check_pattern: string | null } | null;
};
export type MorningGreetingWhy = "off" | "not_today" | "not_confirmed" | "cancelled" | "post_apply" | "already_greeted" | "too_late" | "already_pending" | "other_pending" | "due";

/** 朝の要対応を立てるか（純関数）。due の時だけ立てる */
export function morningViewingGreetingPlan(i: MorningGreetingInput): { register: boolean; why: MorningGreetingWhy } {
  const env = i.env ?? (typeof process !== "undefined" ? process.env : {});
  const no = (why: MorningGreetingWhy) => ({ register: false, why });
  if ((env.VIEWING_MORNING_GREETING ?? "").toLowerCase() === "off" || (env.VIEWING_DAY_GREETING ?? "").toLowerCase() === "off") return no("off");
  if (i.appointmentDay !== "today") return no("not_today");
  if (i.flowConfirmed === false) return no("not_confirmed");
  if (i.flowCancelled) return no("cancelled");
  if (i.postApply) return no("post_apply");
  if (!viewingDayGreetingDue({ ...i, env: {} })) return no("already_greeted");
  const tm = String(i.appointmentTime ?? "").normalize("NFKC").match(/(\d{1,2})\s*[:：時]\s*(\d{2})?/);
  if (tm) {
    const apptMin = Number(tm[1]) * 60 + Number(tm[2] ?? 0);
    const jst = new Date(i.nowMs + JST);
    const nowMin = jst.getUTCHours() * 60 + jst.getUTCMinutes();
    if (apptMin - nowMin < MORNING_MIN_LEAD_MIN) return no("too_late");
  }
  if (i.pending) return no(i.pending.action === "greeting_viewing" ? "already_pending" : "other_pending");
  return { register: true, why: "due" };
}

/** 売上番長グループへの1件通知の2行目（「本日 13:00 のご内覧（メゾン〇〇 305号室）」） */
export function morningGreetingNoticeLine(appt: { time: string | null; place: string | null }): string {
  return `本日${appt.time ? ` ${appt.time} ` : ""}のご内覧${appt.place ? `（${appt.place}）` : ""}の前に内覧挨拶`;
}

/** 当日（JST）に立てた内覧挨拶（内覧前）の要対応は、ブレインの「AIX なし」で取り下げない（純関数・2026-10-08） */
export function keepViewingGreetingItem(open: { action: string; check_pattern: string | null; created_at?: string | null }, nowMs: number = Date.now(), env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {})): boolean {
  if (env.VIEWING_MORNING_GREETING === "off") return false;
  if (open.action !== "greeting_viewing" || open.check_pattern !== "before") return false;
  const day = (ms: number) => Math.floor((ms + 9 * 3600_000) / 86_400_000);
  const at = Date.parse(String(open.created_at ?? ""));
  return Number.isFinite(at) && day(at) === day(nowMs);
}

