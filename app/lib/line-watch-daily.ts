// app/lib/line-watch-daily.ts
// LINE の見張り 2段目: 毎日のまとめ（純関数・DB も fetch も LLM も持たない）。設計 line-watch-design.md §4・§5・§6。
// 手本は search-audit-daily.ts（数えるだけ・「知らせる事」は決まった線で出す・人が読む形は lines）。
//
//   sceneStats        … 場面ごとの一致率（28日・前の週の28日）・事実違い・別の事（14日）・解禁の線までの残り・停止の線（7日）
//   finalCheckStats   … 最終チェックの指摘を 場面×段×code で（最後に残った指摘・修正前の指摘・直しで本文が変わった番）
//   lateStats         … その日の番の返信遅れ（営業時間で数える）
//   screeningCalendarDiff … C7: こちらの確定した内覧と申込ツールの daily_tasks の食い違い（片方にだけ・日時が違う・取りやめで消したのに残る）
//   reviewStats       … 画面の👍／✋（物差しの校正）
//   buildLineWatchDaily / dailyLines … 知らせる事と人が読む形
// テスト: app/lib/__tests__/line-watch-daily.test.ts
import { isAgree, type Verdict, type VerdictDetail } from "./line-watch-judge";
import { compactFinalCheck, businessMinutesBetween, type FcStage } from "./line-watch-turn";
import { jstParts } from "./jst-date";
import { SCREENING_SYNC_ID_PREFIX, shouldSyncViewingToScreening } from "./screening-calendar-sync";

const DAY = 86_400_000;

// ─────────────────────────────────────────────────────────────
// 場面ごとの一致率
// ─────────────────────────────────────────────────────────────
/** 解禁の線（設計 §4・竹内さんの判断待ち＝数字を変える時はここだけ） */
export const UNLOCK = { days: 28, minN: 30, minRate: 0.9, maxFactDiff: 0, differentDays: 14, maxDifferent: 0 } as const;
/** 停止の線（直近7日で一致率 80% 未満・n≥8） */
export const STOP = { days: 7, minN: 8, rate: 0.8 } as const;

export type StatTurn = {
  conversation_id: string;
  customer_turn_at: string;
  scene_key: string | null;
  verdict: Verdict | null;
  verdict_detail?: VerdictDetail | Record<string, unknown> | null;
};
export type SceneWindow = { n: number; agree: number; rate: number | null; factDiff: number; different: number; textN: number; textAgree: number; uncertain: number };
export type SceneStat = {
  scene: string;
  path: string;
  cur: SceneWindow;        // 直近28日
  prev: SceneWindow;       // 7日前までの28日（「2週続けて」の代わり）
  last14Different: number;
  last7: SceneWindow;
  unlock: boolean;         // 解禁の線を満たした（今と1週前の両方）
  stop: boolean;           // 停止の線に当たった
  remaining: string[];     // 解禁の線までの残り（人が読む）
};

const emptyWin = (): SceneWindow => ({ n: 0, agree: 0, rate: null, factDiff: 0, different: 0, textN: 0, textAgree: 0, uncertain: 0 });
function addTo(w: SceneWindow, t: StatTurn) {
  const d = (t.verdict_detail ?? {}) as VerdictDetail;
  if (!t.verdict || t.verdict === "na") return;
  w.n++;
  if (isAgree(t.verdict)) w.agree++;
  if (t.verdict === "different") w.different++;
  if (d.fact_diff) w.factDiff++;
  if (d.uncertain) w.uncertain++;
  if (d.text_verdict) { w.textN++; if (isAgree(d.text_verdict)) w.textAgree++; }
}
const fin = (w: SceneWindow): SceneWindow => ({ ...w, rate: w.n ? Math.round((w.agree / w.n) * 1000) / 1000 : null });
const pct = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`);

export function meetsUnlock(w: SceneWindow, different14: number): boolean {
  return w.n >= UNLOCK.minN && (w.rate ?? 0) >= UNLOCK.minRate && w.factDiff <= UNLOCK.maxFactDiff && different14 <= UNLOCK.maxDifferent;
}

export function sceneStats(turns: ReadonlyArray<StatTurn>, nowMs: number): SceneStat[] {
  const by = new Map<string, { cur: SceneWindow; prev: SceneWindow; last7: SceneWindow; d14: number }>();
  for (const t of turns) {
    const key = t.scene_key;
    if (!key || key.startsWith("対象外")) continue;
    const age = nowMs - Date.parse(t.customer_turn_at);
    if (!(age >= 0)) continue;
    const s = by.get(key) ?? by.set(key, { cur: emptyWin(), prev: emptyWin(), last7: emptyWin(), d14: 0 }).get(key)!;
    if (age < UNLOCK.days * DAY) addTo(s.cur, t);
    if (age >= 7 * DAY && age < (UNLOCK.days + 7) * DAY) addTo(s.prev, t);
    if (age < STOP.days * DAY) addTo(s.last7, t);
    if (age < UNLOCK.differentDays * DAY && t.verdict === "different") s.d14++;
  }
  const out: SceneStat[] = [];
  for (const [scene, s] of by) {
    const cur = fin(s.cur), prev = fin(s.prev), last7 = fin(s.last7);
    const remaining: string[] = [];
    if (cur.n < UNLOCK.minN) remaining.push(`あと ${UNLOCK.minN - cur.n}番`);
    if ((cur.rate ?? 0) < UNLOCK.minRate) remaining.push(`一致率 ${pct(cur.rate)}→${pct(UNLOCK.minRate)}`);
    if (cur.factDiff > UNLOCK.maxFactDiff) remaining.push(`事実違い ${cur.factDiff}件→0`);
    if (s.d14 > UNLOCK.maxDifferent) remaining.push(`別の事（14日）${s.d14}件→0`);
    const nowOk = meetsUnlock(cur, s.d14);
    const prevOk = meetsUnlock(prev, 0);
    if (nowOk && !prevOk) remaining.push("1週前の28日も満たすのを待つ");
    out.push({
      scene, path: scene.split(":")[0], cur, prev, last7, last14Different: s.d14,
      unlock: nowOk && prevOk,
      stop: last7.n >= STOP.minN && (last7.rate ?? 1) < STOP.rate,
      remaining,
    });
  }
  return out.sort((a, b) => b.cur.n - a.cur.n || a.scene.localeCompare(b.scene));
}

/** 場面の鍵を人が読む名前に（「返信:条件提示」→「返信／条件提示」・「AIX:estimate_sheet」→ ラベル） */
export function sceneLabel(key: string, aixLabels?: Record<string, string>): string {
  if (key.startsWith("AIX:")) { const a = key.slice(4); return `AIX ${aixLabels?.[a] ?? a}`; }
  if (key.startsWith("返信:意図:")) return `返信（意図: ${key.slice(6)}）`;
  if (key.startsWith("返信:")) return `返信 ${key.slice(3)}`;
  return key;
}

// ─────────────────────────────────────────────────────────────
// 最終チェックの段ごとの指摘
// ─────────────────────────────────────────────────────────────
export type FcTurn = { scene_key: string | null; customer_turn_at: string; final_check: unknown };
export type FcRow = { scene: string; stage: FcStage; code: string; final: number; pre: number; revised: number; blocks: number };
export type FcStats = { turns: number; withIssues: number; revisedTurns: number; byStage: Partial<Record<FcStage, number>>; rows: FcRow[] };

/**
 * 最終チェックの記録がある番（days 日）を 場面×段×code で数える。
 *   final = 最後に残った指摘・pre = 修正前の指摘（記録に段が無いので同じ code の最後の段か _DET＝決定論・他は不明）
 *   revised = その code が修正前にあり、直し（revision_count>0）で本文が変わった番の数＝「省けるか」の物差し（設計 §5）
 */
export function finalCheckStats(turns: ReadonlyArray<FcTurn>, nowMs: number, days = 28, top = 40): FcStats {
  const map = new Map<string, FcRow>();
  const byStage: Partial<Record<FcStage, number>> = {};
  let n = 0, withIssues = 0, revisedTurns = 0;
  for (const t of turns) {
    if (nowMs - Date.parse(t.customer_turn_at) >= days * DAY) continue;
    if (t.scene_key?.startsWith("対象外")) continue;
    const c = compactFinalCheck(t.final_check);
    if (!c) continue;
    n++;
    if (c.final.length || c.pre.length) withIssues++;
    const revised = c.revisionCount > 0;
    if (revised) revisedTurns++;
    const scene = t.scene_key ?? "（場面なし）";
    const row = (stage: FcStage, code: string) => { const k = `${scene}|${stage}|${code}`; return map.get(k) ?? map.set(k, { scene, stage, code, final: 0, pre: 0, revised: 0, blocks: 0 }).get(k)!; };
    for (const f of c.final) { const r = row(f.stage, f.code); r.final++; if (f.severity === "block") r.blocks++; byStage[f.stage] = (byStage[f.stage] ?? 0) + 1; }
    for (const p of c.pre) { const r = row(p.stage, p.code); r.pre++; if (revised) r.revised++; }
  }
  const rows = [...map.values()].sort((a, b) => b.pre + b.final - (a.pre + a.final) || a.scene.localeCompare(b.scene)).slice(0, top);
  return { turns: n, withIssues, revisedTurns, byStage, rows };
}

// ─────────────────────────────────────────────────────────────
// 返信遅れ
// ─────────────────────────────────────────────────────────────
export const LATE_LINE_MIN = 60;
export type LateTurn = { conversation_id: string; customer_turn_at: string; staff_first_at: string | null; scene_key?: string | null; verdict_detail?: { reason?: string } | Record<string, unknown> | null };
export type LateStats = { turns: number; replied: number; late: number; unrepliedLate: number; medianMin: number | null; p90Min: number | null; worst: Array<{ conversation_id: string; turnAt: string; minutes: number; replied: boolean }> };

/** その日（JST）に来たお客様の番の返信の速さ（営業時間 10〜19時で数える）。申込以降は数えない */
export function lateStats(turns: ReadonlyArray<LateTurn>, dayStartMs: number, nowMs: number): LateStats {
  const mins: number[] = [];
  let n = 0, replied = 0, late = 0, unrepliedLate = 0;
  const worst: LateStats["worst"] = [];
  for (const t of turns) {
    const at = Date.parse(t.customer_turn_at);
    if (!(at >= dayStartMs && at < dayStartMs + DAY)) continue;
    if (t.scene_key?.startsWith("対象外")) continue;
    n++;
    const m = businessMinutesBetween(t.customer_turn_at, t.staff_first_at ?? nowMs);
    if (t.staff_first_at) { replied++; mins.push(m); if (m > LATE_LINE_MIN) late++; }
    else if (m > LATE_LINE_MIN) unrepliedLate++;
    if (m > LATE_LINE_MIN) worst.push({ conversation_id: t.conversation_id, turnAt: t.customer_turn_at, minutes: m, replied: !!t.staff_first_at });
  }
  mins.sort((a, b) => a - b);
  const q = (p: number) => (mins.length ? mins[Math.min(mins.length - 1, Math.floor(p * mins.length))] : null);
  return { turns: n, replied, late, unrepliedLate, medianMin: q(0.5), p90Min: q(0.9), worst: worst.sort((a, b) => b.minutes - a.minutes).slice(0, 10) };
}

// ─────────────────────────────────────────────────────────────
// C7: 申込ツールのカレンダー（daily_tasks）との食い違い
// ─────────────────────────────────────────────────────────────
export type OurViewing = { id: number | string; conversation_id: string | null; customer_name: string | null; event_type: string | null; start_at: string; all_day?: boolean | null; notes: string | null; title?: string | null; is_done?: boolean | null };
export type ScreeningTask = { id: string; customer_name: string | null; content: string | null; date: string | null; time: string | null; end_time?: string | null; done?: boolean | null };
export type C7Kind = "C7a" | "C7b" | "C7c";
export const C7_JA: Record<C7Kind, string> = {
  C7a: "確定した内覧が申込ツールのカレンダーに無い",
  C7b: "申込ツールの日時がこちらと違う",
  C7c: "こちらで消した・未確定に戻した内覧が申込ツールに残っている",
};
export type C7Finding = { code: C7Kind; eventId: string | null; taskId: string | null; conversation_id: string | null; name: string | null; day: string | null; detail: string };

const ymdHm = (iso: string) => { const p = jstParts(iso); return { ymd: `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`, hm: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` }; };
/** 名前の照らし（空白・敬称・絵文字を外して、片方がもう片方を含む） */
export function sameCustomerName(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => String(s ?? "").normalize("NFKC").replace(/[\s　]|さん|様|[\p{Extended_Pictographic}️‍]/gu, "").toLowerCase();
  const x = norm(a), y = norm(b);
  if (x.length < 1 || y.length < 1) return false;
  return x === y || (x.length >= 2 && y.includes(x)) || (y.length >= 2 && x.includes(y));
}
const isViewingTask = (t: ScreeningTask) => /内覧|案内|🏠/.test(String(t.content ?? ""));

/**
 * 突き合わせ（見る日の範囲は呼ぶ側で両方そろえる）。
 *   鍵の行（dt_sumora_cal_<予定の id>）で照らし、無ければ旧の行（同じ日・お客様の名前が合う・内覧の行）を探す（9/30 より前の予定・画面で保存した旧の行）
 *   C7a: 確定した内覧（shouldSyncViewingToScreening）で、終わっていない・今日以降なのに、どちらの行も無い
 *   C7b: 鍵の行の日付・開始時刻がこちらと違う（終日の予定は時刻を見ない）
 *   C7c: 鍵の行があるのに、こちらの予定が無い（消した）か確定でない（未確定・時間確保に戻した）。今日以降の行だけ
 */
export function screeningCalendarDiff(o: { ours: ReadonlyArray<OurViewing>; tasks: ReadonlyArray<ScreeningTask>; todayYmd: string }): C7Finding[] {
  const out: C7Finding[] = [];
  const byKey = new Map<string, ScreeningTask>();
  for (const t of o.tasks) if (t.id?.startsWith(SCREENING_SYNC_ID_PREFIX)) byKey.set(t.id.slice(SCREENING_SYNC_ID_PREFIX.length), t);
  const oursById = new Map(o.ours.map((e) => [String(e.id), e]));
  for (const e of o.ours) {
    if (!shouldSyncViewingToScreening(e.event_type, e.notes)) continue;
    const { ymd, hm } = ymdHm(e.start_at);
    if (ymd < o.todayYmd || e.is_done) continue;
    const keyed = byKey.get(String(e.id));
    if (keyed) {
      const timeDiff = !e.all_day && (keyed.time ?? "") !== "" && (keyed.time ?? "") !== hm;
      if (keyed.date !== ymd || timeDiff) {
        out.push({ code: "C7b", eventId: String(e.id), taskId: keyed.id, conversation_id: e.conversation_id, name: e.customer_name, day: ymd, detail: `こちら ${ymd.slice(5)} ${e.all_day ? "終日" : hm} ／ 申込ツール ${String(keyed.date ?? "").slice(5)} ${keyed.time || "時刻なし"}` });
      }
      continue;
    }
    const legacy = o.tasks.find((t) => !t.id?.startsWith(SCREENING_SYNC_ID_PREFIX) && t.date === ymd && isViewingTask(t) && (sameCustomerName(t.customer_name, e.customer_name) || sameCustomerName(e.customer_name, t.content)));
    if (legacy) continue;
    out.push({ code: "C7a", eventId: String(e.id), taskId: null, conversation_id: e.conversation_id, name: e.customer_name, day: ymd, detail: `${ymd.slice(5)} ${e.all_day ? "終日" : hm} の内覧（予定 #${e.id}）が申込ツールに無い` });
  }
  for (const [key, t] of byKey) {
    if (!t.date || t.date < o.todayYmd || t.done) continue;
    const e = oursById.get(key);
    if (!e) out.push({ code: "C7c", eventId: key, taskId: t.id, conversation_id: null, name: t.customer_name, day: t.date, detail: `申込ツールの ${t.date.slice(5)} ${t.time || ""}「${String(t.content ?? "").slice(0, 30)}」の元の予定 #${key} がこちらに無い（消した）` });
    else if (!shouldSyncViewingToScreening(e.event_type, e.notes)) out.push({ code: "C7c", eventId: key, taskId: t.id, conversation_id: e.conversation_id, name: e.customer_name ?? t.customer_name, day: t.date, detail: `こちらの予定 #${key} は確定でない（未確定・時間確保）のに申込ツールに残っている` });
  }
  const order: C7Kind[] = ["C7c", "C7b", "C7a"];
  return out.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code) || String(a.day ?? "").localeCompare(String(b.day ?? "")));
}

// ─────────────────────────────────────────────────────────────
// 👍／✋（物差しの校正）
// ─────────────────────────────────────────────────────────────
export type ReviewTurn = { verdict: Verdict | null; verdict_review: string | null; verdict_review_verdict?: string | null; verdict_review_rule?: string | null; verdict_reviewed_at?: string | null; verdict_detail?: { reason?: string } | Record<string, unknown> | null };
export type ReviewStats = { reviewed: number; agree: number; disagree: number; byReason: Array<{ reason: string; agree: number; disagree: number }>; confusion: Array<{ rule: string; human: string; n: number }> };
export function reviewStats(turns: ReadonlyArray<ReviewTurn>): ReviewStats {
  let agree = 0, disagree = 0;
  const br = new Map<string, { agree: number; disagree: number }>();
  const cf = new Map<string, number>();
  for (const t of turns) {
    if (t.verdict_review !== "agree" && t.verdict_review !== "disagree") continue;
    const reason = String((t.verdict_detail as { reason?: string } | null)?.reason ?? "");
    const r = br.get(reason) ?? br.set(reason, { agree: 0, disagree: 0 }).get(reason)!;
    if (t.verdict_review === "agree") { agree++; r.agree++; } else { disagree++; r.disagree++; }
    const rule = t.verdict_review_rule ?? t.verdict ?? "?";
    const human = t.verdict_review === "agree" ? rule : t.verdict_review_verdict ?? "?";
    cf.set(`${rule}→${human}`, (cf.get(`${rule}→${human}`) ?? 0) + 1);
  }
  return {
    reviewed: agree + disagree, agree, disagree,
    byReason: [...br.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.disagree - a.disagree || b.agree - a.agree),
    confusion: [...cf.entries()].map(([k, n]) => { const [rule, human] = k.split("→"); return { rule, human, n }; }).sort((a, b) => b.n - a.n),
  };
}

// ─────────────────────────────────────────────────────────────
// 毎日のまとめ
// ─────────────────────────────────────────────────────────────
export type DailyInput = {
  date: string;
  scenes: SceneStat[];
  prevScenes?: Array<{ scene: string; unlock: boolean; stop: boolean }> | null;
  fc: FcStats;
  late: LateStats;
  /** 知らせる番（24〜48時間前に来た・窓が閉じた番）の判定（事実違いを拾う） */
  dayTurns: ReadonlyArray<StatTurn & { name?: string | null }>;
  promises: Array<{ name: string | null; kindJa: string; hours: number; customerActive: boolean }>;
  calendar: Array<{ code: string }>;
  c7: { measured: boolean; reason?: string; findings: C7Finding[] };
  search: Array<{ kind: string }>;
  aixPending: number;
  reviews: ReviewStats;
  capture: { enabled: boolean | null; turns24h: number; tableReady: boolean };
  aixLabels?: Record<string, string>;
};
export type LineWatchDaily = {
  date: string;
  alerts: string[];
  counts: Record<string, number | null>;
  scenes: SceneStat[];
  fc: FcStats;
  late: LateStats;
  c7: DailyInput["c7"];
  reviews: ReviewStats;
};

/** 線（知らせる事） */
export const DAILY_LINES = { promiseHours: 48, aixMissMinN: 5, aixMissRate: 0.5 } as const;

export function buildLineWatchDaily(i: DailyInput): LineWatchDaily {
  const alerts: string[] = [];
  const L = (k: string) => sceneLabel(k, i.aixLabels);
  // 控えが止まっていないか（静かに壊れる所の見張り＝成功の数）
  if (!i.capture.tableReady) alerts.push("控えの表が読めない（本番に流したか・名前が変わっていないか）");
  else if (i.capture.enabled === false) alerts.push("控えを止めている（line_watch_settings.capture_enabled=false）");
  else if (i.capture.turns24h === 0) alerts.push("直近24時間に控えが1番も無い（トリガーが止まっていないか確かめる）");
  if (i.late.late + i.late.unrepliedLate > 0) alerts.push(`返信が60分を超えた番 ${i.late.late + i.late.unrepliedLate}番（返した ${i.late.late}・まだ ${i.late.unrepliedLate}／今日の番 ${i.late.turns}・中央値 ${i.late.medianMin ?? "—"}分）`);
  const overdue = i.promises.filter((p) => p.customerActive && p.hours >= DAILY_LINES.promiseHours);
  if (overdue.length) alerts.push(`約束の未対応（48時間超・お客様は止まっていない）${overdue.length}件: ${overdue.slice(0, 5).map((p) => `${p.name ?? "?"}（${p.kindJa}）`).join("・")}${overdue.length > 5 ? " 他" : ""}`);
  const facts = i.dayTurns.filter((t) => (t.verdict_detail as VerdictDetail | null)?.fact_diff);
  if (facts.length) alerts.push(`AI の案とスタッフで事実（金額・日時・物件）が違った番（前日）${facts.length}番: ${facts.slice(0, 5).map((t) => t.name ?? t.conversation_id.slice(0, 8)).join("・")}`);
  for (const s of i.scenes) {
    if (s.path !== "AIX" || s.last7.n < DAILY_LINES.aixMissMinN) continue;
    const miss = s.last7.different / s.last7.n;
    if (miss >= DAILY_LINES.aixMissRate) alerts.push(`${L(s.scene)} は直近7日 ${s.last7.n}番中 ${s.last7.different}番がスタッフと別の道（AIX 違い）`);
  }
  const cal = new Map<string, number>();
  for (const c of i.calendar) cal.set(c.code, (cal.get(c.code) ?? 0) + 1);
  if (cal.size) alerts.push(`カレンダー: ${[...cal.entries()].map(([k, n]) => `${k} ${n}件`).join("・")}`);
  if (!i.c7.measured) alerts.push(`申込ツールのカレンダーとの突き合わせ（C7）は測れない: ${i.c7.reason ?? "理由不明"}`);
  else if (i.c7.findings.length) {
    const c7 = new Map<string, number>();
    for (const f of i.c7.findings) c7.set(f.code, (c7.get(f.code) ?? 0) + 1);
    alerts.push(`申込ツールのカレンダーと食い違い: ${[...c7.entries()].map(([k, n]) => `${C7_JA[k as C7Kind]} ${n}件`).join("・")}`);
  }
  const idle = i.search.filter((s) => s.kind === "idle").length, empty = i.search.filter((s) => s.kind === "empty").length;
  if (idle) alerts.push(`検索が要るのに動いていないお客様 ${idle}人`);
  if (empty) alerts.push(`最新の検索で送れる物件が0のお客様 ${empty}人`);
  // 場面の解禁／停止の変化（前回のまとめと比べる）
  const prev = new Map((i.prevScenes ?? []).map((p) => [p.scene, p]));
  for (const s of i.scenes) {
    const p = prev.get(s.scene);
    if (s.unlock && !p?.unlock) alerts.push(`${L(s.scene)} が解禁の線を満たした（28日 ${s.cur.n}番・一致 ${pct(s.cur.rate)}）＝開けるかは竹内さんが決める`);
    if (!s.unlock && p?.unlock) alerts.push(`${L(s.scene)} が解禁の線を外れた（一致 ${pct(s.cur.rate)}）`);
    if (s.stop && !p?.stop) alerts.push(`${L(s.scene)} が停止の線に当たった（直近7日 ${s.last7.n}番・一致 ${pct(s.last7.rate)}）`);
  }
  if (i.reviews.disagree > 0) alerts.push(`判定に✋が ${i.reviews.disagree}件（物差しを直す候補: ${i.reviews.byReason.filter((r) => r.disagree).slice(0, 3).map((r) => r.reason || "?").join("・")}）`);
  const counts: Record<string, number | null> = {
    late: i.late.late + i.late.unrepliedLate, day_turns: i.late.turns, promises_overdue: overdue.length, fact_diff: facts.length,
    calendar: i.calendar.length, c7: i.c7.measured ? i.c7.findings.length : null, search_idle: idle, search_empty: empty, aix_pending: i.aixPending,
    scenes_unlock: i.scenes.filter((s) => s.unlock).length, scenes_stop: i.scenes.filter((s) => s.stop).length, reviews: i.reviews.reviewed,
  };
  return { date: i.date, alerts, counts, scenes: i.scenes, fc: i.fc, late: i.late, c7: i.c7, reviews: i.reviews };
}

/** 人が読む形（cron の結果・画面・スクリプト） */
export function dailyLines(d: LineWatchDaily, aixLabels?: Record<string, string>): string[] {
  const L: string[] = [];
  L.push(`LINE の見張り ${d.date}: 今日の番 ${d.late.turns}（返した ${d.late.replied}・中央値 ${d.late.medianMin ?? "—"}分）`);
  if (d.alerts.length) { L.push("■ 知らせる事"); for (const a of d.alerts) L.push(`・${a}`); } else L.push("■ 知らせる事はありません");
  L.push("■ 場面ごとの一致率（28日・比べられた番）");
  for (const s of d.scenes.slice(0, 15)) {
    L.push(`・${sceneLabel(s.scene, aixLabels)}: ${s.cur.n}番・一致 ${pct(s.cur.rate)}${s.cur.textN ? `（文 ${s.cur.textN}番中 ${s.cur.textAgree}）` : ""}・事実違い ${s.cur.factDiff}・別の事(14日) ${s.last14Different}${s.unlock ? "・【解禁の線】" : ""}${s.stop ? "・【停止の線】" : ""}${!s.unlock && s.remaining.length ? `・残り: ${s.remaining.join("／")}` : ""}`);
  }
  if (d.fc.turns) {
    L.push(`■ 最終チェック（28日・${d.fc.turns}番・指摘あり ${d.fc.withIssues}・直した ${d.fc.revisedTurns}）: ${Object.entries(d.fc.byStage).map(([k, n]) => `${k} ${n}`).join("・") || "最後に残った指摘なし"}`);
    for (const r of d.fc.rows.slice(0, 8)) L.push(`・${sceneLabel(r.scene, aixLabels)}／${r.stage}／${r.code}: 修正前 ${r.pre}・最後 ${r.final}${r.blocks ? `（block ${r.blocks}）` : ""}・直した ${r.revised}`);
  }
  if (d.reviews.reviewed) L.push(`■ 👍／✋: ${d.reviews.reviewed}件（✋ ${d.reviews.disagree}）`);
  return L;
}

/** 日本時間のその日の始まり（UTC ms） */
export function jstDayStartMs(nowMs: number): number {
  return Math.floor((nowMs + 9 * 3600_000) / DAY) * DAY - 9 * 3600_000;
}
export function jstYmd(nowMs: number): string {
  return new Date(nowMs + 9 * 3600_000).toISOString().slice(0, 10);
}
