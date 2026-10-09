// app/lib/payment-timing.ts — 「初期費用のお金を用意できる時期」から、お申込みの日を逆算する（純関数・DB も fetch も持たない）
//
// 2026-10-08 竹内「内覧は大丈夫。初期費用の振込が12月下旬以降になるように逆算して申込していく必要ある。ここの部分も一番良い方法で逆算するようにする」
//
// 【数字の根拠】（scripts/audit-payment-timing.ts・実送信）
//   - 審査は 3日〜10日（会社の事実 screening_flow・竹内さんの決定 09-26）
//   - お部屋を抑えられるのは申込から1ヶ月（会社の事実 hold_period・実送信「お申込みから1ヶ月間が入居可能時期」）
//   - 初期費用のお振込の期日は入居日が基準: 「貸主側から初期費用のお振込期限が設けられるのですが基本的にご入居の10日前が期限」（6/9）／
//     10/08 竹内さんの決定＝**ご入居の10日前で確定**（8/17 従業員の「5日から1週間前程」は使わない・会社の事実 payment_method にも入れた）
//   - 審査通過→お振込の連絡は中央 0.1日（7件）＝請求は審査通過の後すぐ来るが、期日は入居日が基準
// 【逆算】お金の用意できる日を M とすると:
//   入居日 ≥ M + 10日（期日＝入居日の10日前 ≥ M）
//   入居日 ≤ 申込日 + 30日（抑えられる1ヶ月）→ 申込日 ≥ M − 20日
//   審査（最長10日）が期日より前に終わる: 申込日 + 10 ≤ 入居日 − 10 → 入居日 M+10 なら 申込日 ≤ M − 10
//   ＝ **申込の目安は M−20日〜M−10日**（この幅なら入居日を M+10 日頃に置け、お振込は M 以降・審査も間に合う）。
//   10/08 竹内さん「基本 A で、期間が長すぎたら B」: M − 今日 ≤ 20日（APPLY_NOW_MAX_MONEY_LEAD_DAYS）なら A＝今お申込みで抑えて入居日を後ろに／超えたら B＝M−20〜M−10日頃のお申込みを伝えて待って頂く（申込へは出さない）
// 【実物】969f01 9/20「10月にもらえる給料で…最短10月9日」→ 竹内さん「一度お申込しお部屋を抑えた状態でご内覧如何でしょうか」（M−19日＝A）／
//   c7ca2f「最短でも10月末にしか初期費用を用意出来ない」→ 竹内さん「10月下旬以後で…ご案内」（内覧の時期）
//   決まった言い回しは実送信に無い → 竹内さんの実送信の語で一文の型を組む（paymentTimingCoreText）
// 戻す: PAYMENT_TIMING=off
// テスト: app/lib/__tests__/payment-timing.test.ts
import { resolveDateExpr } from "./customer-circumstances";

export const SCREENING_DAYS_MAX = 10;
export const SCREENING_DAYS_MIN = 3;
export const HOLD_DAYS = 30;
export const PAY_DUE_BEFORE_MOVE_IN_DAYS = 10;
/** 言った日から何日まで有効か（用意できる日が過ぎて30日でも落とす） */
export const MONEY_READY_TTL_DAYS = 90;

const DAY = 86_400_000;
const JST = 9 * 3600_000;
const dayStart = (ms: number) => Math.floor((ms + JST) / DAY) * DAY - JST;
const WD = ["日", "月", "火", "水", "木", "金", "土"];
export const mdw = (ms: number) => { const d = new Date(ms + JST); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WD[d.getUTCDay()]}）`; };

export type MoneyReady = { fromDayMs: number; quote: string; saidAt: string };

const MONEY_RE = /初期費用|お金|資金|費用|支払|払え|払う|払い|振り?込|入金|貯め|給料|ボーナス/;
const READY_RE = /以降|以後|から|にしか|しか|最短|になる|になります|になり|用意(?:が|は)?(?:でき|出来)|準備(?:が|は)?(?:でき|出来)|まで(?:は|に)?(?:用意|払え|無理|難し)/;
// 質問の形（「いつ払う感じなんですか？」「含まれているってことですよね」）と給料明細の月数の話は読まない（365日の当たり 11 を目で読んで外した: 3722d1×3・8b260f・3644ea）
const NOT_RE = /明細|源泉|年収|審査|保証|在籍|家賃(?:は|が)?\d|月々|含まれ|ですよね|ですかね|ますか|でしょうか|[？?]|[かヶケ]月分|働き/;

function sentences(text: string): string[] {
  return text.normalize("NFKC").split(/\n+|(?<=[。！!？?])/).map((s) => s.trim()).filter(Boolean);
}

/** お客様の発言（古い順）から「お金を用意できる日」を読む（決まった言い方だけ・一番新しい物） */
export function extractMoneyReady(custMsgs: ReadonlyArray<{ text: string | null | undefined; createdAt: string }>, nowMs: number): MoneyReady | null {
  let found: MoneyReady | null = null;
  for (const m of custMsgs) {
    const t = String(m.text ?? "");
    if (!t.trim() || /①|【ご入居の時期】|生年月日|携帯番号|【お申込/.test(t)) continue;
    const said = Date.parse(m.createdAt);
    if (!Number.isFinite(said) || nowMs - said > MONEY_READY_TTL_DAYS * DAY) continue;
    for (const s0 of sentences(t)) {
      const s = s0.replace(/(\d{1,2})月の(\d{1,2})日/g, "$1月$2日");
      if (!MONEY_RE.test(s) || !READY_RE.test(s) || NOT_RE.test(s)) continue;
      // 文に日付が2つある時は後ろの方（「10月にもらえる給料で…最短10月9日」）
      const starts = [...s.matchAll(/\d{1,2}月|\d{1,2}[\/／]\d|来月|今月末|月末/g)].map((x) => x.index ?? 0);
      const day = starts.length ? resolveDateExpr(s.slice(starts[starts.length - 1]), said) : null;
      if (day == null || day < dayStart(said)) continue;
      found = { fromDayMs: day, quote: s0.slice(0, 50), saidAt: m.createdAt };
    }
  }
  if (found && found.fromDayMs + 30 * DAY < nowMs) return null;
  return found;
}

/**
 * 10/08 竹内さん「基本 A で、期間が長すぎたら B」:
 *   A＝今お申込みしてお部屋を抑え、ご入居日を M+10日 以降に置く（抑えられる1ヶ月の中に収まる時）
 *   B＝今は申し込まず「〇月〇日頃にお申込み頂く形」を伝えて待ってもらう（収まらない時）
 * 線: 今日申し込んで、入居を申込から1ヶ月以内（HOLD_DAYS）に置き、お振込（入居の10日前）が M 以降になるか
 *   ＝ M + PAY_DUE_BEFORE_MOVE_IN_DAYS ≤ 今日 + HOLD_DAYS ⇔ M − 今日 ≤ APPLY_NOW_MAX_MONEY_LEAD_DAYS（＝20日）。
 *   審査（最長10日）は入居の10日前までに終わる: 入居 ≥ 今日+20 も要るが、入居を max(M+10, 今日+20) に置けば 今日+30 以内なので線は変わらない（安全側）。
 */
export const APPLY_NOW_MAX_MONEY_LEAD_DAYS = HOLD_DAYS - PAY_DUE_BEFORE_MOVE_IN_DAYS;

export type ApplyPlan = {
  moneyDayMs: number;
  decision: "A" | "B";
  /** B の申込の目安の幅（M−20日〜M−10日） */
  applyFromMs: number; applyToMs: number;
  /** ご入居日の一番早い日（A は max(M+10, 今日+審査10日+期日10日)・B は M+10） */
  moveInFromMs: number;
  /** お客様の入居の希望（分かれば）と食い違うか */
  moveInConflict: string | null;
};

export function planApplyTiming(i: { moneyDayMs: number; nowMs: number; desiredMoveInMs?: number | null }): ApplyPlan {
  const M = dayStart(i.moneyDayMs);
  const today = dayStart(i.nowMs);
  const decision: "A" | "B" = M - today <= APPLY_NOW_MAX_MONEY_LEAD_DAYS * DAY ? "A" : "B";
  const applyFrom = M - (HOLD_DAYS - PAY_DUE_BEFORE_MOVE_IN_DAYS) * DAY;
  const applyTo = M - SCREENING_DAYS_MAX * DAY;
  const moveInFrom = decision === "A"
    ? Math.max(M + PAY_DUE_BEFORE_MOVE_IN_DAYS * DAY, today + (SCREENING_DAYS_MAX + PAY_DUE_BEFORE_MOVE_IN_DAYS) * DAY)
    : M + PAY_DUE_BEFORE_MOVE_IN_DAYS * DAY;
  let moveInConflict: string | null = null;
  if (i.desiredMoveInMs != null && Number.isFinite(i.desiredMoveInMs) && dayStart(i.desiredMoveInMs) < M + PAY_DUE_BEFORE_MOVE_IN_DAYS * DAY) {
    moveInConflict = `入居の希望（${mdw(i.desiredMoveInMs)}）だとお振込の期日（入居の${PAY_DUE_BEFORE_MOVE_IN_DAYS}日前）がお金の用意できる日より前になる`;
  }
  return { moneyDayMs: M, decision, applyFromMs: applyFrom, applyToMs: applyTo, moveInFromMs: moveInFrom, moveInConflict };
}

export function paymentTimingEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.PAYMENT_TIMING ?? "").trim().toLowerCase() !== "off";
}

const md = (ms: number) => { const d = new Date(ms + JST); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`; };

/**
 * 本文の一文の型（10/08 竹内さん「決まった言い回しは無いので竹内さんの言い回しの形で」）。創作の決まり文句にせず、竹内さんの実送信の語だけを組む:
 *   A ← 「よろしければ一度お申込しお部屋を抑えた状態で」（9/20・9/10）＋「ご入居日…設定させて頂きました」（7/26）＋「初期費用のお支払いは一括でのお振込」（9/14）
 *   B ← 「ご入居日はお申込日から30日以内にご入居頂く形となります」（9/22）＋「8月1日まで待機しお申込み頂く形となります」（7/01）
 *       ＋連絡の約束「〇月〇日に改めてご連絡させて頂きます😊！！」（contact-promise.parseContactPromise が kind=contact で読む＝カレンダーの【必ず】に入る）
 */
export function paymentTimingCoreText(p: ApplyPlan, customerName?: string | null): string {
  const name = (customerName ?? "").trim();
  if (p.decision === "A") {
    return `よろしければ一度お申込しお部屋を抑えた状態で、ご入居日を${md(p.moveInFromMs)}以降に設定させて頂きますので、初期費用のお振込は${md(p.moneyDayMs)}以降となります😊！！`;
  }
  return [
    `ご入居日はお申込日から30日以内にご入居頂く形となりますので、初期費用のお振込を${md(p.moneyDayMs)}以降にする場合は、${md(p.applyFromMs)}〜${md(p.applyToMs)}頃にお申込み頂く形となります！！`,
    // 10/08 YUMA: 気に入った物件がある番で「ピックアップしお送り」は判定役に後退（STATE_REGRESSION）と読まれた → 連絡の約束（contact-promise が kind=contact でカレンダーへ）
    `${md(p.applyFromMs)}に改めてご連絡させて頂きます😊！！`,
  ].join("\n");
}

/** ブレイン・返信への注記。A/B を明記する。条件の場面では出さない */
export function buildPaymentTimingNote(mr: MoneyReady | null, o: { nowMs: number; desiredMoveInMs?: number | null; scene?: string | null; customerName?: string | null }): string {
  if (!mr || o.scene === "conditions") return "";
  const p = planApplyTiming({ moneyDayMs: mr.fromDayMs, nowMs: o.nowMs, desiredMoveInMs: o.desiredMoveInMs });
  const said = mdw(Date.parse(mr.saidAt));
  const lines = [
    `- お金を用意できる日: ${mdw(p.moneyDayMs)} 以降＝${said} の発言「${mr.quote}」`,
    `- 逆算（お振込の期日はご入居の${PAY_DUE_BEFORE_MOVE_IN_DAYS}日前・お部屋を抑えられるのはお申込みから1ヶ月・審査 ${SCREENING_DAYS_MIN}〜${SCREENING_DAYS_MAX}日）`,
    p.decision === "A"
      ? `- 判断 A（今お申込みしてお部屋を抑える）: 今お申込みしても1ヶ月の中でご入居日を ${mdw(p.moveInFromMs)} 以降に置け、お振込はお金の用意の後になる。申込を勧めてよい（AIX【申込へ】可）。入居日の一文を添える`
      : `- 判断 B（今は申し込まず時期を伝えて待って頂く）: 用意できる日まで${APPLY_NOW_MAX_MONEY_LEAD_DAYS}日より先＝今申し込むと1ヶ月の中でご入居日を後ろにできない。AIX【申込へ】は出さない。返信で ${mdw(p.applyFromMs)}〜${mdw(p.applyToMs)} 頃のお申込みを伝え、${mdw(p.applyFromMs)} に連絡（ピックアップ）を約束する。内覧はいつでもよい`,
    `- 使う一文（竹内さんの実送信の語で組んだ型・日付を変えない）: 「${paymentTimingCoreText(p, o.customerName).replace(/\n/g, "／")}」`,
  ];
  if (p.moveInConflict) lines.push(`- ⚠ ${p.moveInConflict}`);
  return `【初期費用のお金の時期と申込の逆算（決まった計算）】\n${lines.join("\n")}`;
}
