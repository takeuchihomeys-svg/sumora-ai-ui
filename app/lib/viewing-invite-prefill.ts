// app/lib/viewing-invite-prefill.ts
// AIX【内覧へ！】（＝ブレインの呼び名で【内覧調整】・viewing_invite）を開いた時に、どの日に先にチェックを入れるか（純関数・DB も fetch も持たない）。
//
// 2026-10-05 14:49 竹内さん（会話「ゆいと」・お客様「ありがとうございます。内見いつ行けますでしょうか？」で AIX【内覧へ！】を開くと
//   ✅10/7(水) 14:00〜16:00・✅10/8(木) 14:00〜15:00 が先に入り、下に赤字「日程を入力してください（例：9月18日）」）:
//   「日程はお客さんから指定がなければいれない」
//
// 原因（コード）:
//   ① 帯「内覧の希望あり → AIX 内覧へ！で日程調整」（page.tsx P3.2.5）が、日付が届いていない時も「内覧日指定あり」で開いていた
//   ② 内覧日指定ありで希望日が無い時の既定が「本日以外の空いている日を全部 ON」（i > 0 && !fullyBooked）＝10/7・10/8 が入った
//   ③ 通常モードの既定は「直近の空いている日を3つ ON」（10/02 の決まり・nearestBookableDays）
//   ④ 内覧日指定ありは「日程」の欄（文字）だけを見て生成し、欄が空なら投げていた＝チェック済みの日があっても「日程を入力してください」
// 決まり（この関数）:
//   ・お客様の最新の発言（viewing-date-request.latestCustomerTurnText）に日付の指定がある → その日だけ（内覧日指定あり）
//   ・幅の指定（土日・週末・平日・今週・来週・再来週）→ その幅の中の空いている日を前から最大3つ（通常モード＝「直近ですと」の形のまま）
//   ・指定が無い → どの日も入れない（スタッフが選ぶ。選ばなければ日程なしの文＝「ご都合よろしいお日にち」を伺う）
//   ・退去予定物件だけは 9/19 竹内さんの決まり（退去日の翌日から順に空いている日を3つ）のまま（resolveVacancySlotEnabled の結果を渡す）
//   推測はしない（「いつ行けますか」「早めに」「なるべく早く」は日付の指定ではない）。
//   戻す: NEXT_PUBLIC_VIEWING_INVITE_PREFILL=nearest3（指定が無い時に従来の「直近の空いている日を3つ」）
import { latestCustomerTurnText, extractRequestedViewingDates, viewingAskClauses, type RequestedViewingDate } from "./viewing-date-request";
import { jstParts } from "./jst-date";
import { nearestBookableDays, isBookable, VIEWING_CANDIDATE_DAYS, type CandidateDay } from "./viewing-candidates";
import { extractCircumstances, validCircumstances } from "./customer-circumstances";

const DAY_MS = 86_400_000;

type Msg = { sender?: string | null; text?: string | null };

export type ViewingDateSpec =
  | { kind: "none" }
  /** 日付の指定（今日・明日・18日・10月8日・木曜日・来週の土曜…）＝内覧日指定あり */
  | { kind: "dates"; dates: RequestedViewingDate[]; evidence: string }
  /** 幅の指定（土日・週末・平日・今週・来週・再来週）＝その幅の中の空いている日 */
  | { kind: "range"; ymds: string[]; label: string; evidence: string };

const pad2 = (n: number) => String(n).padStart(2, "0");
const ymdOfUtc = (t: number) => { const x = new Date(t); return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`; };

/** 幅の語（日付の指定が無い時だけ見る） */
const WEEKEND_RE = /(再来週|来週|今週)?\s*の?\s*(?:週末|土日|土・日|土曜日?(?:か|or|・|、|\/)日曜日?)/;
const WEEKDAY_RE = /平日/;
const WEEK_RE = /(再来週|来週|今週)(?!\s*の?\s*[月火水木金土日]曜)/;

/**
 * お客様の最新の発言から、内覧の日の指定を読む（決定論）。
 * 日付（extractRequestedViewingDates）が先・無ければ幅の語・どちらも無ければ none。断りの文（「土日は仕事」）の語は読まない。
 */
export function customerViewingDateSpec(messagesOldestFirst: ReadonlyArray<Msg>, nowMs: number = Date.now()): ViewingDateSpec {
  const text = latestCustomerTurnText(messagesOldestFirst);
  const fromSpec = availableFromSpec(messagesOldestFirst, nowMs);
  if (!text.trim()) return fromSpec ?? { kind: "none" };
  const dates = extractRequestedViewingDates(text, nowMs);
  // 2026-10-08 竹内さん「〇日以降の時は AIX の内覧調整でその日以降で出す」: 「20日以降でお願いします」はその日だけ（内覧日指定あり）ではなく、
  //   その日から先の空いている日（幅）。今の発言の日付が1つで「以降・以後・から」が付いている時だけ幅にする
  if (dates.length === 1 && fromSpecEnabled() && hasFromWord(text, dates[0].m, dates[0].d)) {
    return { kind: "range", ymds: ymdsFrom(dates[0].ymd, FROM_RANGE_DAYS), label: `${dates[0].md}以降`, evidence: text.slice(0, 80) };
  }
  if (dates.length > 0) return { kind: "dates", dates, evidence: text.slice(0, 80) };

  const now = jstParts(nowMs);
  const today = Date.UTC(now.y, now.m - 1, now.d);
  const mondayOffset = now.dow === 0 ? -6 : 1 - now.dow; // 今週の月曜（日本時間）
  const weekStart = (prefix: string | undefined) => today + (mondayOffset + (prefix === "再来週" ? 14 : prefix === "来週" ? 7 : 0)) * DAY_MS;
  const span = (from: number, to: number) => {
    const out: string[] = [];
    for (let t = Math.max(from, today); t <= to; t += DAY_MS) out.push(ymdOfUtc(t));
    return out;
  };
  // 「毎週土日しか空いてないのですが」（監査 f2967621 8/17）は断りの語（空いてない）を含むが「しか」で限る＝その幅の指定。断りの除き方より先に読む
  const only = text.normalize("NFKC").match(/(再来週|来週|今週)?\s*の?\s*(週末|土日|平日)\s*(?:しか|のみ|だけ)/);
  const clauses = only ? [`${only[1] ?? ""}${only[2]}なら`, ...viewingAskClauses(text)] : viewingAskClauses(text);
  for (const clause of clauses) {
    const w = clause.match(WEEKEND_RE);
    if (w) {
      // 前置きが無い「土日」「週末」＝次に来る土日（今日が土曜なら今日・明日／日曜なら今日）
      const prefix = w[1];
      const mon = prefix ? weekStart(prefix) : (now.dow === 0 ? today - 6 * DAY_MS : weekStart(undefined));
      const ymds = span(mon + 5 * DAY_MS, mon + 6 * DAY_MS);
      if (ymds.length) return { kind: "range", ymds, label: `${prefix ?? ""}土日`, evidence: clause.slice(0, 60) };
    }
    if (WEEKDAY_RE.test(clause)) {
      const ymds: string[] = [];
      for (let i = 0; i < 10 && ymds.length < 7; i++) {
        const t = today + i * DAY_MS;
        const dow = new Date(t).getUTCDay();
        if (dow >= 1 && dow <= 5) ymds.push(ymdOfUtc(t));
      }
      return { kind: "range", ymds, label: "平日", evidence: clause.slice(0, 60) };
    }
    const wk = clause.match(WEEK_RE);
    if (wk) {
      const mon = weekStart(wk[1]);
      const ymds = span(mon, mon + 6 * DAY_MS);
      if (ymds.length) return { kind: "range", ymds, label: wk[1], evidence: clause.slice(0, 60) };
    }
  }
  return fromSpec ?? { kind: "none" };
}

// ─── 2026-10-08 竹内さん（把握「お客様の事情」の続き）「その通りで AIX の内覧調整でその日以降で出すようにする。あくまでも AIX から返信」 ───
//   お客様が前の発言（直近の会話）で「〇日以降なら来られる」と言っていて（customer-circumstances.ts の available_from・鮮度つき）、
//   今の発言に日付の指定が無い時は、その日から先の空いている日を前から最大3つ（幅の指定と同じ形）。返信の本文では日時を書かない（今の決まりどおり AIX で）。
//   戻す: NEXT_PUBLIC_VIEWING_INVITE_FROM_CIRCUMSTANCE=off
export const FROM_RANGE_DAYS = 7;
function fromSpecEnabled(): boolean {
  return (process.env.NEXT_PUBLIC_VIEWING_INVITE_FROM_CIRCUMSTANCE ?? "").trim().toLowerCase() !== "off";
}
function hasFromWord(text: string, m: number, d: number): boolean {
  const t = String(text ?? "").normalize("NFKC");
  return new RegExp(`(?:${m}\\s*月\\s*${d}\\s*日?|${m}\\s*[/／]\\s*${d}|(?<![0-9])${d}\\s*日)\\s*(?:の)?\\s*(?:以降|以後|から)`).test(t);
}
function ymdsFrom(ymd: string, n: number): string[] {
  const [y, mo, d] = ymd.split("-").map(Number);
  const start = Date.UTC(y, mo - 1, d);
  return Array.from({ length: n }, (_, i) => ymdOfUtc(start + i * DAY_MS));
}
/** 前の発言の「〇日以降なら来られる」（有効な物）を幅の指定にする。日付が今日以前・無ければ null */
export function availableFromSpec(messagesOldestFirst: ReadonlyArray<Msg & { rawCreatedAt?: string | null; createdAt?: string | null }>, nowMs: number = Date.now()): ViewingDateSpec | null {
  if (!fromSpecEnabled()) return null;
  const cust = messagesOldestFirst
    .filter((m) => m.sender === "customer" && (m.rawCreatedAt || m.createdAt))
    .map((m) => ({ text: m.text ?? "", createdAt: String(m.rawCreatedAt || m.createdAt) }));
  if (!cust.length) return null;
  const from = validCircumstances(extractCircumstances(cust, nowMs + 1), nowMs).find((c) => c.kind === "available_from" && c.fromDayMs != null);
  if (!from || from.fromDayMs == null) return null;
  const today = jstParts(nowMs);
  const todayUtc = Date.UTC(today.y, today.m - 1, today.d);
  const fromUtc = from.fromDayMs + 9 * 3600_000; // JST 0時 → その日の UTC 0時と同じ暦日
  if (fromUtc <= todayUtc) return null;
  const ymd = ymdOfUtc(fromUtc);
  const md = `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
  return { kind: "range", ymds: ymdsFrom(ymd, FROM_RANGE_DAYS), label: `${md}以降（お客様のご都合）`, evidence: from.quote };
}

/** カレンダーの取得に足す日（日付の指定はその日・幅はその幅の日）。fetchCalendarSlots の extraYmds に渡す */
export function specExtraYmds(spec: ViewingDateSpec): string[] {
  if (spec.kind === "dates") return spec.dates.map((d) => d.ymd);
  if (spec.kind === "range") return [...spec.ymds];
  return [];
}

export type ViewingInviteDay = CandidateDay & { ymd: string };
export type ViewingInvitePrefill = {
  /** days と同じ並びの ON/OFF */
  enabled: boolean[];
  /** 内覧日指定ありで開くか（日付の指定がある時だけ） */
  specificMode: boolean;
  /** 画面に出す理由（なぜこの日が入った／入っていないか） */
  reason: string;
};

/** 指定が無い時の既定（戻し用の切り替え） */
export type NoSpecBehavior = "empty" | "nearest3";
export function noSpecBehaviorFromEnv(v: string | undefined): NoSpecBehavior {
  return (v ?? "").trim() === "nearest3" ? "nearest3" : "empty";
}

/**
 * 開いた時のチェック（決定論）。
 *   vacancyEnabled … 退去予定物件の時の resolveVacancySlotEnabled の結果（退去予定でなければ null）
 *   baseCount     … days の前から何日が「基準の日」か（fetchCalendarSlots の baseCount・従来の戻しの時だけ使う）
 */
export function resolveViewingInvitePrefill(o: {
  days: ReadonlyArray<ViewingInviteDay>;
  spec: ViewingDateSpec;
  vacancyEnabled?: boolean[] | null;
  baseCount?: number;
  noSpec?: NoSpecBehavior;
}): ViewingInvitePrefill {
  const { days, spec } = o;
  if (o.vacancyEnabled) return { enabled: o.vacancyEnabled, specificMode: false, reason: "退去予定のお部屋: 退去日の翌日から順に空いている日（9/19 の決まり）" };
  if (spec.kind === "dates") {
    const want = new Set(spec.dates.map((d) => d.ymd));
    return {
      enabled: days.map((d) => want.has(d.ymd)),
      specificMode: true,
      reason: `お客様の指定の日（${spec.dates.map((d) => d.label).join("・")}）`,
    };
  }
  if (spec.kind === "range") {
    const want = new Set(spec.ymds);
    const picked: number[] = [];
    for (let i = 0; i < days.length && picked.length < VIEWING_CANDIDATE_DAYS; i++) if (want.has(days[i].ymd) && isBookable(days[i])) picked.push(i);
    const on = new Set(picked);
    return {
      enabled: days.map((_, i) => on.has(i)),
      specificMode: false,
      reason: picked.length ? `お客様の指定「${spec.label}」の空いている日` : `お客様の指定「${spec.label}」の日は空きがありません（日を選んでください）`,
    };
  }
  if (o.noSpec === "nearest3") {
    const on = new Set(nearestBookableDays(days, VIEWING_CANDIDATE_DAYS, o.baseCount ?? days.length));
    return { enabled: days.map((_, i) => on.has(i)), specificMode: false, reason: "直近の空いている日（従来の既定）" };
  }
  return { enabled: days.map(() => false), specificMode: false, reason: "お客様から日にちのご指定はありません（こちらから出す日を選んでください・選ばなければ日程なしで伺う文になります）" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 出口: 日程の材料が無いのに出た日程の段（「直近ですと／M/D(曜) HH:MM〜…」）を落とす
// ─────────────────────────────────────────────────────────────────────────────
// 材料（calendar_info・お客様の希望日・退去予定の候補・スタッフの候補日時）が1つも無い時に生成文に出た日時は、どこにも根拠が無い＝作った日程。
// 材料が無い時だけ効かせるので、材料のある文の日程は1文字も触らない（誤削除 0 の線は「材料が無い」こと自体）。
const SCHEDULE_LINE_RE = /^\s*(?:本日|明日|明後日)?\s*[（(]?\s*[0-9０-９]{1,2}\s*[\/／月]\s*[0-9０-９]{1,2}\s*日?\s*[（(]?\s*[月火水木金土日]?\s*(?:曜日?)?\s*[）)]?\s*[0-9０-９]{1,2}\s*[:：時]/;
const NEAREST_HEAD_RE = /^\s*直近(?:です|だ)と\s*$/;
export function stripUnbackedScheduleLines(text: string): { text: string; removed: string[] } {
  const lines = String(text ?? "").split("\n");
  const removed: string[] = [];
  const kept: string[] = [];
  for (const l of lines) {
    if (NEAREST_HEAD_RE.test(l) || SCHEDULE_LINE_RE.test(l)) { removed.push(l.trim()); continue; }
    // 「ご案内可能です😊！！」だけが残った行（日付の行の続き）も落とす
    if (removed.length && /^\s*(?:にて)?ご案内(?:可能|出来|でき)(?:です|ます)[^\n]{0,6}$/.test(l)) { removed.push(l.trim()); continue; }
    kept.push(l);
  }
  if (!removed.length) return { text, removed };
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}
