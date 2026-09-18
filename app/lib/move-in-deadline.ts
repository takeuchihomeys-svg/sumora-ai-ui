// app/lib/move-in-deadline.ts
// 入居希望時期の言い方から「一番遅い入居日」と「お申込みの目安日」を出す（純関数・DB 依存なし）。
//
// 2026-09-18 竹内（ゆーた 事例）「10月中の入居って10月末までなので、こんなに急がなくても大丈夫。
//   今まだ9月なのに、なぜかここの10月の部分を間違えて捉えてしまっている」
//
// 【何が起きたか】お客様の条件フォーム ①【ご入居の時期】⇒**10月中**。
//   生成された初回返信（そのまま送信済み）:
//     「10月中のご入居ですと審査に最短でも2週間程はかかりますので、**今週中にお申込みいただく必要がございます**」
//   9/18 時点で 10月中（＝10/31まで）なら、申込は10月半ばで間に合う。急かす必要はない。
//
// 【原因】generate-reply の申込期限の計算が
//     const tDay = 日の指定があればその日 : (「末」を含むなら 28 : **1**)
//   となっており、**日の指定が無い言い方を全部「その月の1日」**として扱っていた。
//     「10月中」→ 10/1（本当は 10/31）／「9月」→ 9/1（本当は 9/30）／「9月末」→ 9/28（本当は 9/30）
//   さらに残り日数に関わらず文面が**「今週中」で固定**だった。
//
// 【実データ（property_customers.move_in_time）】素の月（「9月」「10月」「8月」）が最多の書き方で、
//   「〜中」「〜頃」「上旬/中旬/下旬/末/頭/後半」「10月~12月」のような幅のある言い方が大半。
//   幅がある時は**一番遅い日**で見ないと、こちらが勝手に前倒しして急かすことになる。
import { jstParts } from "./jst-date";

/** 申込から入居までの最短日数（審査3〜10日＋契約書類の記入・初期費用の入金）。社内の定説と同じ値 */
export const APPLY_TO_MOVE_IN_DAYS = 14;

/**
 * 申込の目安日がこの日数より先なら、急かす文は出さない。
 * 実データの根拠: 実際にスタッフが「今週中にお申込み」と書いた例（7/1・8/1入居希望）は
 * 申込の目安日まで17日だった。ゆーた（9/18・10月中）は29日あり、書いていない。
 */
export const URGE_WITHIN_DAYS = 21;

export type MoveInKind =
  | "date"       // 10月1日 / 10月29日〜11月1日
  | "month_end"  // 10月 / 10月中 / 10月頃 / 10月末
  | "early"      // 10月上旬 / 10月頭
  | "mid"        // 10月中旬
  | "late"       // 10月下旬 / 10月後半
  | "year_end";  // 今年中

export type MoveInWindow = {
  /** その言い方で「一番遅い入居日」（これより後にはならない）。急かすかどうかはこの日で決める */
  latest: { y: number; m: number; d: number };
  kind: MoveInKind;
  /** 元の言い方（証拠） */
  evidence: string;
};

const ZEN = "０１２３４５６７８９";
function toHalf(s: string): string {
  return s.replace(/[０-９]/g, (c) => String(ZEN.indexOf(c)));
}
function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function ymd(y: number, m: number, d: number) { return { y, m, d }; }

/** 期日にならない言い方（急かす根拠にしてはいけない） */
const NO_DEADLINE_RE = /いつでも|未定|不明|特に(?:無|な)し|決(?:まって|まり)|次第|急いで(?:い)?ない|良い物件|いい物件/;
/** 「早く入りたい」＝期日ではない。ここから申込期限を作らない（急かす口実にしない） */
const ASAP_RE = /最短|すぐ|即|早め|早く|可及的/;

/**
 * 入居希望時期の言い方から「一番遅い入居日」を出す。
 * 期日として読めない時（いつでも・未定・最短・物件次第）は null＝**急かす文は出さない**。
 */
export function resolveMoveInWindow(text: string | null | undefined, nowIso: string): MoveInWindow | null {
  const raw = toHalf((text ?? "").trim());
  if (!raw) return null;
  if (NO_DEADLINE_RE.test(raw)) return null;

  const now = jstParts(nowIso);
  if (!Number.isFinite(now.y)) return null;
  const yearOf = (m: number, d: number) => (m < now.m || (m === now.m && d < now.d)) ? now.y + 1 : now.y;

  // 「今年中」「年内」
  if (/今年中|年内/.test(raw)) {
    return { latest: ymd(now.y, 12, 31), kind: "year_end", evidence: raw };
  }

  // 月の指定を全部拾い、**一番後ろ**を使う（「10月~12月」「10月後半から11月」＝遅い方が期限）
  const months = [...raw.matchAll(/(\d{1,2})\s*月/g)].map((m) => parseInt(m[1], 10)).filter((m) => m >= 1 && m <= 12);
  if (!months.length) return null;
  const tMonth = months[months.length - 1];

  // その月に続く部分だけを見る（前の月の「上旬」等に引きずられない）
  const tail = raw.slice(raw.lastIndexOf(`${tMonth}月`));

  // 日の指定（「10月29日〜11月1日」なら最後の月の後ろにある日）
  const dayMatch = tail.match(/(\d{1,2})\s*日/);
  if (dayMatch) {
    const d = parseInt(dayMatch[1], 10);
    const y = yearOf(tMonth, d);
    if (d >= 1 && d <= lastDayOfMonth(y, tMonth)) {
      return { latest: ymd(y, tMonth, d), kind: "date", evidence: raw };
    }
  }

  // 幅のある言い方 → その幅の**終わり**
  let kind: MoveInKind = "month_end";
  let day: number;
  const y0 = yearOf(tMonth, lastDayOfMonth(now.y, tMonth));
  if (/上旬|頭|初め|はじめ|前半/.test(tail)) { kind = "early"; day = 10; }
  else if (/中旬/.test(tail)) { kind = "mid"; day = 20; }
  else if (/下旬|後半/.test(tail)) { kind = "late"; day = lastDayOfMonth(y0, tMonth); }
  else { kind = "month_end"; day = lastDayOfMonth(y0, tMonth); } // 「10月」「10月中」「10月頃」「10月末」は月末まで
  const y = yearOf(tMonth, day);
  return { latest: ymd(y, tMonth, day), kind, evidence: raw };
}

export type ApplyDeadline = {
  window: MoveInWindow;
  /** お申込みの目安日（一番遅い入居日から審査・契約の分を引いた日） */
  applyBy: { y: number; m: number; d: number };
  /** 今日から申込の目安日まで何日あるか */
  daysUntilApply: number;
  /** 今日から一番遅い入居日まで何日あるか */
  daysUntilMoveIn: number;
  /** 「10月17日」 */
  applyByLabel: string;
};

function utc(p: { y: number; m: number; d: number }): number {
  return Date.UTC(p.y, p.m - 1, p.d);
}

/** 入居希望時期から申込の目安日を出す */
export function applyDeadlineOf(w: MoveInWindow, nowIso: string): ApplyDeadline | null {
  const now = jstParts(nowIso);
  if (!Number.isFinite(now.y)) return null;
  const applyMs = utc(w.latest) - APPLY_TO_MOVE_IN_DAYS * 86_400_000;
  const a = new Date(applyMs);
  const applyBy = ymd(a.getUTCFullYear(), a.getUTCMonth() + 1, a.getUTCDate());
  const todayMs = Date.UTC(now.y, now.m - 1, now.d);
  return {
    window: w,
    applyBy,
    daysUntilApply: Math.floor((applyMs - todayMs) / 86_400_000),
    daysUntilMoveIn: Math.floor((utc(w.latest) - todayMs) / 86_400_000),
    applyByLabel: `${applyBy.m}月${applyBy.d}日`,
  };
}

/**
 * この返信で申込の期限に触れるか。
 *   ・期日として読めない言い方（いつでも・未定・最短・物件次第）では触れない
 *   ・申込の目安日がまだ先（3週間より先）なら触れない＝**勝手に急かさない**
 *   ・目安日を過ぎている時も「今週中」とは書かない（間に合わせ方は人が決める）
 */
export function resolveApplyDeadlineNote(
  moveInText: string | null | undefined,
  nowIso: string,
): ApplyDeadline | null {
  const w = resolveMoveInWindow(moveInText, nowIso);
  if (!w) return null;
  const a = applyDeadlineOf(w, nowIso);
  if (!a) return null;
  if (a.daysUntilApply < 0 || a.daysUntilApply > URGE_WITHIN_DAYS) return null;
  return a;
}
