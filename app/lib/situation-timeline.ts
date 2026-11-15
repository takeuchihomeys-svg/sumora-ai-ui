// app/lib/situation-timeline.ts — 今の状況の記録の「時系列」の段（純関数・DB/LLM なし・1か所）
//
// 2026-11-15 作業員L（竹内さん 11/15「メモして状況をいつ言っていたか、いつ行ったかなど時系列の部分も具体的に強化する」
//   「カレンダーから予定もちゃんと把握する　時間がある予定は内覧予定」KB P1・統括役の頼み3と7）。
//   現状把握の物差し（scripts/audit-situation-grasp.ts）で、お客様の時の言葉（来週・月末・給料日…）を絶対の日付に直した値が
//   竹内さん本人の番 131番で1つも材料に無かった（土台の穴）。カレンダーも今日の内覧（is_hot）と【必ず】の一部しか読んでいない。
// ここで決める物（ブレイン・書き手・AIX・最終チェックが同じ関数を読む）:
//   ① resolveTimeWords: お客様の言葉の相対の言い方を、言った日（日本時間）を基準に絶対の日付・期間に直す。直せない言葉（給料日・ボーナス）は「日付は人による」
//      日の語（明日・昨日）は relative-date.resolveRelativeDays と同じ考え（長い語を先）。週は月曜始まり。
//   ② readCalendarEvents: calendar_events を「内覧の予定」と「約束・連絡の予定」に分ける。
//      決まり（竹内さん 11/15）: 時刻がある予定（all_day=false）は event_type が other・phone・application でも内覧の予定として読む。
//      終日の予定（property_send・follow_up・estimate_sheet・【必ず】・viewing の「〇〇 内覧調整」）は約束と連絡の予定として読む
//      （60日の数: 終日の viewing 187件の題は「〇〇 内覧調整」＝時刻の無い内覧ではなく内覧の調整の予定）。
//   ③ timelineBlock: ①②を1つの材料の塊【時系列の帳面】にする（事実だけ・道の言葉は書かない）。
// 置き方: BRAIN_SITUATION_TIMELINE=on の時だけ brain-core が材料に足す（既定 off＝今と1文字も変わらない）。
import { JST_OFFSET_MS, WEEKDAYS_JA, jstDayStartMs } from "./jst-date";

const DAY = 86_400_000;
type Env = Record<string, string | undefined>;
export const situationTimelineOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.BRAIN_SITUATION_TIMELINE ?? "").trim().toLowerCase() === "on";

const ymdOf = (ms: number) => { const d = new Date(ms + JST_OFFSET_MS); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: d.getUTCDay() }; };
/** 日本時間のその日の 0時（UTC の ms） */
const jstMidnight = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - JST_OFFSET_MS;
export const mdLabel = (ms: number) => { const x = ymdOf(ms); return `${x.m}/${x.d}（${WEEKDAYS_JA[x.w]}）`; };
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export type TimeWord = { word: string; fromMs: number | null; toMs: number | null; label: string };
/** お客様の言葉の相対の言い方 → 絶対の日付か期間（言った時刻 atMs を基準）。直せない言葉は fromMs=null */
export function resolveTimeWords(text: string | null | undefined, atMs: number): TimeWord[] {
  const t = String(text ?? "").normalize("NFKC");
  if (!t.trim()) return [];
  const out: TimeWord[] = [];
  const today = jstDayStartMs(atMs);
  const { y, m, w } = ymdOf(atMs);
  const mondayOf = (ms: number) => ms - ((ymdOf(ms).w + 6) % 7) * DAY;
  const add = (word: string, from: number | null, to: number | null, note?: string) => {
    if (out.some((o) => o.word === word)) return;
    const label = from == null ? note ?? "日付は人による（確かめないと決まらない）" : to != null && to !== from ? `${mdLabel(from)}〜${mdLabel(to)}` : mdLabel(from);
    out.push({ word, fromMs: from, toMs: to, label });
  };
  const taken: Array<[number, number]> = [];
  const hit = (re: RegExp, f: (mm: RegExpMatchArray) => void) => {
    for (const mm of t.matchAll(new RegExp(re.source, "g"))) {
      const i = mm.index ?? 0, e = i + mm[0].length;
      if (taken.some(([s, x]) => i < x && e > s)) continue;
      taken.push([i, e]); f(mm);
    }
  };
  // 長い・具体の言い方から先に
  hit(/(\d{1,2})月(\d{1,2})日/, (mm) => { const mo = Number(mm[1]), d = Number(mm[2]); const yy = mo < m - 1 ? y + 1 : y; const ms = jstMidnight(yy, mo, d); add(mm[0], ms, ms); });
  hit(/(\d{1,2})月(?:の)?(末|上旬|中旬|下旬|頭|初め|中|いっぱい)/, (mm) => {
    const mo = Number(mm[1]); const yy = mo < m - 1 ? y + 1 : y; const ld = lastDay(yy, mo);
    const r: Record<string, [number, number]> = { 末: [ld - 4, ld], 上旬: [1, 10], 頭: [1, 5], 初め: [1, 5], 中旬: [11, 20], 下旬: [21, ld], 中: [1, ld], いっぱい: [1, ld] };
    const [a, b] = r[mm[2]]; add(mm[0], jstMidnight(yy, mo, a), jstMidnight(yy, mo, b));
  });
  hit(/再来週/, () => { const mon = mondayOf(today) + 14 * DAY; add("再来週", mon, mon + 6 * DAY); });
  hit(/来週(?:末)?/, (mm) => { const mon = mondayOf(today) + 7 * DAY; add(mm[0], mm[0].endsWith("末") ? mon + 5 * DAY : mon, mon + 6 * DAY); });
  hit(/今週(?:末)?/, (mm) => { const mon = mondayOf(today); add(mm[0], mm[0].endsWith("末") ? mon + 5 * DAY : today, mon + 6 * DAY); });
  hit(/週末|土日/, (mm) => { const sat = mondayOf(today) + 5 * DAY; const s = w === 0 ? today : sat; add(mm[0], s, w === 0 ? today : sat + DAY); });
  hit(/来月(?:末|頭|中旬|上旬|下旬)?/, (mm) => {
    const mo = m === 12 ? 1 : m + 1, yy = m === 12 ? y + 1 : y, ld = lastDay(yy, mo); const tail = mm[0].slice(2);
    const r: Record<string, [number, number]> = { "": [1, ld], 末: [ld - 4, ld], 頭: [1, 5], 上旬: [1, 10], 中旬: [11, 20], 下旬: [21, ld] };
    const [a, b] = r[tail] ?? [1, ld]; add(mm[0], jstMidnight(yy, mo, a), jstMidnight(yy, mo, b));
  });
  hit(/今月(?:末|中)?|月末/, (mm) => { const ld = lastDay(y, m); add(mm[0], mm[0] === "今月中" ? today : jstMidnight(y, m, Math.max(ld - 4, 1)), jstMidnight(y, m, ld)); });
  hit(/年内/, () => add("年内", today, jstMidnight(y, 12, 31)));
  hit(/年明け/, () => add("年明け", jstMidnight(y + 1, 1, 1), jstMidnight(y + 1, 1, 15)));
  hit(/明々後日|明明後日|しあさって/, (mm) => add(mm[0], today + 3 * DAY, today + 3 * DAY));
  hit(/明後日|あさって/, (mm) => add(mm[0], today + 2 * DAY, today + 2 * DAY));
  hit(/明日|あした|明朝/, (mm) => add(mm[0], today + DAY, today + DAY));
  hit(/一昨日|おととい/, (mm) => add(mm[0], today - 2 * DAY, today - 2 * DAY));
  hit(/昨日|きのう/, (mm) => add(mm[0], today - DAY, today - DAY));
  hit(/(?<![月\d])(\d{1,2})日(?![本間程後前])/, (mm) => { const d = Number(mm[1]); if (d < 1 || d > 31) return; const cur = ymdOf(today); const thisM = jstMidnight(cur.y, cur.m, Math.min(d, lastDay(cur.y, cur.m))); const ms = thisM >= today - 3 * DAY ? thisM : jstMidnight(cur.m === 12 ? cur.y + 1 : cur.y, cur.m === 12 ? 1 : cur.m + 1, d); add(mm[0], ms, ms); });
  hit(/給料日|ボーナス|給料が入/, (mm) => add(mm[0], null, null));
  return out;
}

export type CalendarRow = { title?: string | null; event_type?: string | null; start_at?: string | null; end_at?: string | null; all_day?: boolean | null; is_done?: boolean | null; notes?: string | null };
export type CalendarRead = { kind: "viewing" | "promise"; atMs: number; hasTime: boolean; done: boolean; type: string; title: string };
/** 竹内さんの決まり（11/15）: 時刻がある予定は内覧の予定（event_type を問わない）・終日の予定は約束と連絡の予定 */
export function readCalendarEvents(rows: ReadonlyArray<CalendarRow>): CalendarRead[] {
  return rows.flatMap((r) => {
    const at = Date.parse(String(r.start_at ?? ""));
    if (!Number.isFinite(at)) return [];
    const hasTime = r.all_day === false;
    // 題の中のお客様の名前（〇〇さん）は材料に出さない（種類と時刻だけ）
    const title = String(r.title ?? "").replace(/\S{0,12}さん/g, "").replace(/\s+/g, " ").trim().slice(0, 30);
    return [{ kind: hasTime ? "viewing" : "promise", atMs: at, hasTime, done: r.is_done === true, type: String(r.event_type ?? "other"), title } as CalendarRead];
  }).sort((a, b) => a.atMs - b.atMs);
}

const TYPE_JA: Record<string, string> = { viewing: "内覧", property_send: "物件の送付", follow_up: "追いかけの連絡", estimate_sheet: "御見積書", application: "申込", phone: "電話", photo: "写真", other: "その他" };
const hm = (ms: number) => { const d = new Date(ms + JST_OFFSET_MS); return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };

export type TimelineInput = { customerMsgs: ReadonlyArray<{ text: string | null; atMs: number }>; calendar: ReadonlyArray<CalendarRow>; nowMs: number };
export type TimelineRecord = { words: Array<TimeWord & { saidAtMs: number }>; viewings: CalendarRead[]; promises: CalendarRead[] };
export function buildTimeline(i: TimelineInput): TimelineRecord {
  // 2026-11-15 試験 q092 で直した: 「ここは最短11月中旬でしょうか？」は物件の入居日を聞いている問い＝お客様の予定ではない。
  //   問いの文（？・か で終わる）の日付は帳面に入れない（お客様が自分の予定として言った文だけ）
  const statements = (t: string | null) => String(t ?? "").split(/(?<=[。！!？?\n])/).filter((s) => s.trim() && !/[？?]\s*$|(?:でしょうか|ですか|ますか|か)\s*[。]?\s*$/.test(s.trim())).join("");
  const words = i.customerMsgs.flatMap((m) => resolveTimeWords(statements(m.text), m.atMs).map((w) => ({ ...w, saidAtMs: m.atMs })));
  const cal = readCalendarEvents(i.calendar);
  return { words: words.slice(-8), viewings: cal.filter((c) => c.kind === "viewing"), promises: cal.filter((c) => c.kind === "promise") };
}
/** 材料の塊（事実だけ・空なら空文字） */
export function timelineBlock(rec: TimelineRecord, nowMs: number): string {
  const lines: string[] = [];
  if (rec.words.length) {
    lines.push("・お客様の時の言葉（言った日を基準に直した日付）:");
    for (const w of rec.words) lines.push(`  -「${w.word}」（${mdLabel(w.saidAtMs)}に言った）→ ${w.label}`);
  }
  const vFuture = rec.viewings.filter((v) => v.atMs >= jstDayStartMs(nowMs) && !v.done), vPast = rec.viewings.filter((v) => !vFuture.includes(v)).slice(-3);
  if (vFuture.length || vPast.length) {
    lines.push("・内覧の予定（カレンダーの時刻がある予定）:");
    for (const v of vFuture) lines.push(`  - ${mdLabel(v.atMs)} ${hm(v.atMs)}（これから・${TYPE_JA[v.type] ?? v.type}${v.title ? `・${v.title}` : ""}）`);
    for (const v of vPast) lines.push(`  - ${mdLabel(v.atMs)} ${hm(v.atMs)}（${v.done ? "済み" : "過ぎた・済みの印なし"}・${TYPE_JA[v.type] ?? v.type}）`);
  }
  const pOpen = rec.promises.filter((p) => !p.done).slice(-5);
  if (pOpen.length) {
    lines.push("・約束と連絡の予定（カレンダーの終日の予定・済みの印なし）:");
    for (const p of pOpen) lines.push(`  - ${mdLabel(p.atMs)}（${TYPE_JA[p.type] ?? p.type}${p.title ? `・${p.title}` : ""}${p.atMs < jstDayStartMs(nowMs) ? "・日が過ぎている" : ""}）`);
  }
  return lines.length ? `\n\n【時系列の帳面（日本時間・決まった計算）】\n${lines.join("\n")}` : "";
}
