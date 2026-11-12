// app/lib/time-facts.ts — 時間の事実を1か所で決まった計算で出す（純関数・DB/LLM なし）。ブレインと統括に「時間の事実」として渡す欄を作る
//
// 2026-11-12 作業員19（竹内さん 11/12「まだ必要な土台があれば強化する」・統括役「時間の土台」）。スイッチ TIME_FACTS=on（既定 off＝今と1文字も変わらない）。
// なぜ: 時間の決まりがあちこちに別々の数字で散っていた（一覧は下の TIME_LINES_IN_USE）。business-clock.ts（11/03 作業員6）が暦・営業時間の芯だが誰も呼んでいなかった。
//   ここはその上に「経過・約束の期限・入居希望日までの日数」を足して、1つの事実の束（TimeFacts）と1つの行（timeFactsLine）にする。
// 置き方（道を引っぱらない）: 書くのは事実だけ（今・曜日・祝日・営業の今の状態・次に開く時・経過・期限・日数）。「〜する」「選ぶ」「約束する」「AIX」「返信」は書かない
//   （決めるのはブレイン・P0 9eb6aa9c）。確かめられない決まり（定休日・祝日の管理会社）は「今の決まりの扱い」と書き、事実のように言い切らない。
// 竹内さんの決定（KB）: 5fe999f8（11/04 募集状況の確認は21時より前に営業時間の終了を付けない・設備の確認と交渉は18時の線）・5d9e56b5（募集状況の確認は弊社の営業時間中ならいつでも）・
//   9fd703f4（夜の管理会社への確認は約束の返信＋明日）・5739dd62（日をまたいだ番に「先ほど」と書かない＝経過の日数を事実で渡す）・22c7e985（入居が先は1ヶ月半前から探す）・fact_phone_hours（電話は19時まで）。
// テスト: app/lib/__tests__/time-facts.test.ts
import { JP_HOLIDAYS, PHONE_LAST_HOUR, MGMT_CLOSE_HOUR } from "./business-clock";
import { jstParts, WEEKDAYS_JA, JST_OFFSET_MS } from "./jst-date";
import { COMPANY_CLOSE_HOUR } from "./mgmt-hours-split";

type Env = Record<string, string | undefined>;
export function timeFactsEnabled(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.TIME_FACTS ?? "").trim().toLowerCase() === "on";
}

/** 管理会社が開く時（9時・after-hours.ts の MGMT_OPEN_HOUR と同じ値。値の一致はテストで見る） */
export const MGMT_OPEN_HOUR = 9;
const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

export type TimeLine = { where: string; line: string; value: string; kb: string; note: string };
/**
 * 今、時間の線を使っている所の一覧（2026-11-12 の origin/main の読み・行番号は変わる）。値の食い違いは note に書く。
 * ここは「一覧」であって、各所はまだこの関数を呼んでいない（TIME_FACTS は情報を足すだけ・既存の決まりは変えない）。
 */
export const TIME_LINES_IN_USE: readonly TimeLine[] = [
  { where: "app/lib/final-check-roots2.ts sameDayPromiseBlocked", line: "TIME_INVALID（本日中の約束）", value: "18時以降または土日（旧）／FC_TIME_INVALID_TARGET=on で管理会社側の相手は18時・自社作業は19時・土日は一律止める", kb: "9fd703f4・5fe999f8", note: "5fe999f8 は募集状況の確認は21時までは付けないと決めた。この関数の MGMT_TARGET_RE に「募集状況・空室」が入っており、ネットで確かめられる募集状況まで18時で止める（食い違い）" },
  { where: "app/lib/mgmt-hours-split.ts nightMgmtClosingLine・nightMgmtBrainNote", line: "夜の管理会社（MGMT_NIGHT 系）", value: "18時（設備・交渉）／募集状況の確認は COMPANY_CLOSE_HOUR 21時", kb: "5fe999f8", note: "決定どおり。土曜の扱いは saturday 引数で別（日曜・祝日の線が無い）" },
  { where: "app/lib/business-clock.ts", line: "暦と営業時間の芯（誰も呼んでいない）", value: "電話19・管理会社 閉18・弊社 閉21・定休日は空", kb: "fact_phone_hours", note: "MGMT_CLOSE_HOUR が after-hours.ts にも別に定義（同じ18・値の一致はテスト）。開く時刻 9 は after-hours.ts のみ" },
  { where: "app/api/generate-reply/route.ts getJSTHour", line: "返信の生成の時刻", value: "18（夜の管理会社）・COMPANY_CLOSE_HOUR 21", kb: "9fd703f4・5fe999f8", note: "getJSTHour が generate-reply・generate-reply-patterns・cron 3本に別々に定義（同じ計算の写し・5か所）" },
  { where: "app/lib/phone-call.ts PHONE_LAST_HOUR", line: "電話は19時まで", value: "19", kb: "fact_phone_hours（10/02）", note: "business-clock.ts にも同じ PHONE_LAST_HOUR（二重定義・値は同じ）" },
  { where: "app/lib/brain-core.ts 信号6 followup_revive", line: "お客様が黙った日数", value: "3日以上（物件提案済み・予約送信なし）", kb: "d76e886d（追客＝物件の AIX・3回無視で hot から外す）", note: "日数だけで決め、お客様の保留の型（また連絡します・入居が先）・追客の回数を見ない。audit-followup-cadence.ts（作業員19）で線を引き直す" },
  { where: "app/lib/brain-core.ts 物件検索統括（2383付近）", line: "物件検索の推奨度", value: "送付日数 3日・7日の帯／連続未返信送付2件以上は探さない", kb: "d76e886d", note: "2件（コード）と3回（決定）の食い違い" },
  { where: "app/lib/brain-core.ts 補正（4183〜4260）", line: "直近3日以内の発言だけ矯正", value: "daysSinceLastCustomerMsg <= 3", kb: "—", note: "1本の閾値。未返信の連投を基準にすると場面ごとの差が出ない（作業員19 の洗い出し）" },
  { where: "app/lib/contact-promise.ts farMoveInTurn", line: "入居が先", value: "連絡の日＝入居の1.5ヶ月前が FAR_MOVE_IN_MIN_DAYS（7日）以上先／半年（180日）以上先は2ヶ月前", kb: "22c7e985・入居が先の連絡の時期は遠さで使い分ける", note: "決定どおり（数は env で動く）" },
  { where: "app/lib/payment-timing（brain-core 4859付近）", line: "お金の用意できる日", value: "20日より先なら申込へではなく連絡の日を約束", kb: "決定（用意できる日の20〜10日前に申込）", note: "決定どおり" },
  { where: "app/lib/turn-elapsed.ts ELAPSED_TURN_MIN", line: "今の番からの経過", value: "60分", kb: "11/05 竹内さん（遅れの転機）", note: "TURN_ELAPSED_TWO_CHOICE 既定 off" },
  { where: "app/lib/brain-analysis-mode.ts", line: "分析し直しの時間", value: "UNCHANGED_REUSE_HOURS 6・24時間 full・DUPLICATE 45秒", kb: "—", note: "コスト側の線（時間の事実ではない）" },
];

export type DayFact = { ymd: string; md: string; dow: string; holiday: string | null; weekend: boolean };
export type Elapsed = { minutes: number; label: string; sameDay: boolean; calendarDays: number; whenLabel: string };
export type PromiseDue = { label: string; ymd: string; daysUntil: number; state: "overdue" | "today" | "tomorrow" | "future" };
export type TimeFacts = {
  now: { ymd: string; md: string; dow: string; hour: number; minute: number; holiday: string | null; weekend: boolean };
  phoneOpen: boolean;
  companyOpen: boolean;
  /** 管理会社が今開いているか（土日祝は休み＝今の決まりの扱い・定休日は未確認） */
  mgmtOpen: boolean;
  mgmtNextOpen: { day: DayFact; sameDay: boolean; hoursUntil: number } | null;
  sinceCustomer: Elapsed | null;
  sinceStaff: Elapsed | null;
  promises: PromiseDue[];
  moveIn: { ymd: string; daysUntil: number; label: string } | null;
};

export type TimeFactsInput = {
  nowMs?: number;
  /** テストの時計（TEST_CLOCK_JST_HOUR）を効かせたい時に jstParts().hour を渡す */
  hour?: number;
  lastCustomerAtIso?: string | null;
  lastStaffAtIso?: string | null;
  promises?: ReadonlyArray<{ label: string; ymd: string }>;
  /** 入居希望の始まりの日（YYYY-MM-DD・contact-promise.resolveConditionMoveIn の start.ymd） */
  moveInYmd?: string | null;
};

const ymdOf = (ms: number) => { const p = jstParts(ms); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
const dayStartMs = (ymd: string) => Date.parse(`${ymd}T00:00:00+09:00`);
const daysBetweenYmd = (a: string, b: string) => Math.round((dayStartMs(b) - dayStartMs(a)) / DAY);
function dayFact(ms: number): DayFact {
  const p = jstParts(ms); const ymd = ymdOf(ms);
  return { ymd, md: `${p.m}/${p.d}`, dow: WEEKDAYS_JA[p.dow], holiday: JP_HOLIDAYS[ymd] ?? null, weekend: p.dow === 0 || p.dow === 6 };
}
const mgmtClosedDay = (d: DayFact) => d.weekend || !!d.holiday;

export function elapsedLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return "";
  if (minutes < 1) return "1分未満";
  if (minutes < 60) return `${Math.round(minutes)}分`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}時間`;
  const d = Math.floor(h / 24); const rh = h % 24;
  return rh ? `${d}日と${rh}時間` : `${d}日`;
}
function elapsedFrom(iso: string | null | undefined, nowMs: number): Elapsed | null {
  const at = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(at) || at > nowMs + 60_000) return null;
  const minutes = Math.max(0, (nowMs - at) / 60_000);
  const calendarDays = daysBetweenYmd(ymdOf(at), ymdOf(nowMs));
  const whenLabel = calendarDays === 0 ? "今日" : calendarDays === 1 ? "昨日" : calendarDays === 2 ? "一昨日" : `${calendarDays}日前`;
  return { minutes: Math.round(minutes), label: elapsedLabel(minutes), sameDay: calendarDays === 0, calendarDays, whenLabel };
}

/** 次に管理会社が開く時（開いている間は null。今日まだ開く前なら今日の 9:00・それ以外は次の平日の 9:00） */
function nextMgmtOpen(nowMs: number, hour: number): TimeFacts["mgmtNextOpen"] {
  const today = dayFact(nowMs);
  if (!mgmtClosedDay(today) && hour < MGMT_OPEN_HOUR) return { day: today, sameDay: true, hoursUntil: MGMT_OPEN_HOUR - hour };
  if (!mgmtClosedDay(today) && hour < MGMT_CLOSE_HOUR) return null;
  for (let i = 1; i <= 10; i++) {
    const d = dayFact(nowMs + i * DAY);
    if (!mgmtClosedDay(d)) {
      const msUntil = dayStartMs(d.ymd) + MGMT_OPEN_HOUR * 3600_000 - nowMs;
      return { day: d, sameDay: false, hoursUntil: Math.max(0, Math.round(msUntil / 3600_000)) };
    }
  }
  return null;
}

export function computeTimeFacts(i: TimeFactsInput = {}): TimeFacts {
  const nowMs = i.nowMs ?? Date.now();
  const p = jstParts(nowMs);
  const hour = typeof i.hour === "number" ? i.hour : p.hour;
  const today = dayFact(nowMs);
  const mgmtOpen = !mgmtClosedDay(today) && hour >= MGMT_OPEN_HOUR && hour < MGMT_CLOSE_HOUR;
  const todayYmd = ymdOf(nowMs);
  const promises: PromiseDue[] = (i.promises ?? []).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.ymd)).map((x) => {
    const daysUntil = daysBetweenYmd(todayYmd, x.ymd);
    return { label: x.label, ymd: x.ymd, daysUntil, state: daysUntil < 0 ? "overdue" : daysUntil === 0 ? "today" : daysUntil === 1 ? "tomorrow" : "future" };
  });
  let moveIn: TimeFacts["moveIn"] = null;
  if (i.moveInYmd && /^\d{4}-\d{2}-\d{2}$/.test(i.moveInYmd)) {
    const daysUntil = daysBetweenYmd(todayYmd, i.moveInYmd);
    const months = Math.round((daysUntil / 30.4) * 10) / 10;
    moveIn = { ymd: i.moveInYmd, daysUntil, label: daysUntil < 0 ? `${-daysUntil}日前（過ぎている）` : daysUntil < 31 ? `あと${daysUntil}日` : `あと${daysUntil}日（約${months}ヶ月）` };
  }
  return {
    now: { ymd: todayYmd, md: today.md, dow: today.dow, hour, minute: p.minute, holiday: today.holiday, weekend: today.weekend },
    phoneOpen: hour < PHONE_LAST_HOUR,
    companyOpen: hour < COMPANY_CLOSE_HOUR,
    mgmtOpen,
    mgmtNextOpen: nextMgmtOpen(nowMs, hour),
    sinceCustomer: elapsedFrom(i.lastCustomerAtIso, nowMs),
    sinceStaff: elapsedFrom(i.lastStaffAtIso, nowMs),
    promises,
    moveIn,
  };
}

/** ブレインと統括に渡す1行（事実だけ・道の言葉なし） */
export function timeFactsLine(f: TimeFacts): string {
  const parts: string[] = [];
  parts.push(`今 ${f.now.md}（${f.now.dow}）${f.now.hour}:${pad(f.now.minute)}${f.now.holiday ? `・祝日（${f.now.holiday}）` : f.now.weekend ? "・土日" : ""}`);
  parts.push(`電話は19時まで（今は${f.phoneOpen ? "可" : "終わり"}）`);
  parts.push(`弊社の営業は${COMPANY_CLOSE_HOUR}時まで（今は${f.companyOpen ? "営業中" : "終わり"}）`);
  const mg = f.mgmtOpen ? "今は営業中" : f.mgmtNextOpen
    ? `今は営業時間外・次に開くのは${f.mgmtNextOpen.sameDay ? "今日" : `${f.mgmtNextOpen.day.md}（${f.mgmtNextOpen.day.dow}）`} ${MGMT_OPEN_HOUR}:00（約${f.mgmtNextOpen.hoursUntil}時間後）`
    : "今は営業時間外";
  parts.push(`管理会社は平日 ${MGMT_OPEN_HOUR}〜${MGMT_CLOSE_HOUR}時（土日祝は休みの扱い・${mg}）`);
  if (f.sinceCustomer) parts.push(`お客様が最後に送ってから ${f.sinceCustomer.label}（${f.sinceCustomer.whenLabel}${f.sinceCustomer.sameDay ? "・同じ日" : "・日をまたいでいる"}）`);
  if (f.sinceStaff) parts.push(`こちらが最後に送ってから ${f.sinceStaff.label}（${f.sinceStaff.whenLabel}${f.sinceStaff.sameDay ? "・同じ日" : "・日をまたいでいる"}）`);
  for (const pr of f.promises) parts.push(`${pr.label}の期限 ${pr.ymd.slice(5).replace("-", "/")}（${pr.state === "overdue" ? `${-pr.daysUntil}日過ぎている` : pr.state === "today" ? "今日" : pr.state === "tomorrow" ? "明日" : `あと${pr.daysUntil}日`}）`);
  if (f.moveIn) parts.push(`入居希望日まで ${f.moveIn.label}`);
  return `\n【時間の事実（決まった計算・日本時間）】${parts.join("／")}\n`;
}

/** 道の言葉が行に混ざっていないかの見張り（テスト用）。事実の欄に「する・選ぶ・約束・AIX・返信」を入れない */
export const TIME_FACTS_FORBIDDEN_RE = /選ぶ|選べ|すべき|してください|約束(?:する|して)|AIX|返信(?:する|で)|送る(?:こと|べき)/;

export { JST_OFFSET_MS };
