// app/lib/line-watch-eval-server.ts
// LINE の見張り 2段目の DB 側（cron line-watch-eval・line-watch-daily から呼ぶ）。決まりは全部純関数（line-watch-judge.ts・line-watch-daily.ts）。
//   evaluateLineWatchTurns … 番ごとに「実際」の列（staff_first_at・staff_texts・staff_aix・decision_id・draft_ready_before_staff）と
//                            判定（verdict・verdict_detail・scene_key・judge_version・evaluated_at）を書く。書くのは line_watch_turns の2段目の列だけ
//                            （updated_at は触らない＝1段目の「控えの様子」はトリガーの書き込みだけを数える）
//   buildLineWatchDailyReport … 毎日のまとめ（場面ごとの一致率・最終チェックの段ごと・返信遅れ・約束・カレンダー C1〜C7・検索・👍✋）
// LLM なし。送信・AIX・会話の表には一切書かない。
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { staffWriterOfBurst, staffWriterSplitEnabled } from "./staff-writer";
import { staffWindowOf, judgeTurn, cleanDraft, pickJudgeDraft, JUDGE_VERSION, type WindowMsg, type WindowPress, type Verdict, type VerdictDetail } from "./line-watch-judge";
import { resolveAckTopicScope, outOfTopicActs } from "./ack-topic-scope";
import { sceneKeyOf } from "./line-watch-turn";
import {
  sceneStats, finalCheckStats, lateStats, screeningCalendarDiff, reviewStats, buildLineWatchDaily, dailyLines, jstDayStartMs, jstYmd,
  type StatTurn, type OurViewing, type ScreeningTask, type C7Finding,
} from "./line-watch-daily";
import { isTestConversation } from "./test-conversations";
import { loadLineWatch } from "./line-watch-server";
import { BRAIN_AIX_LABELS } from "./aix-button-view";
import { detectOutgoingResidue } from "./outgoing-residue";
import { draftToSendableText } from "./draft-text";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const P = (s: string) => Date.parse(s);

async function readAll<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, max = 20_000): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < max; i += 1000) {
    const r = await q(i, i + 999);
    if (r.error) throw new Error(r.error.message);
    const d = (r.data ?? []) as T[];
    rows.push(...d);
    if (d.length < 1000) break;
  }
  return rows;
}
async function withConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; await fn(items[idx]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

type TurnRow = {
  id: number; conversation_id: string; customer_turn_at: string; conv_status: string | null;
  draft_last: string | null; draft_last_at: string | null; draft_first: string | null; draft_first_at: string | null; draft_versions: number | null; draft_sentinel: string | null;
  brain_action: string | null; brain_reply_mode: string | null; brain_versions: number | null; tpo_label: string | null;
  verdict: Verdict | null; verdict_detail: VerdictDetail | null; judge_version: string | null; evaluated_at: string | null;
};
type Msg = WindowMsg & { conversation_id: string };
type Press = WindowPress & { conversation_id: string };
type Decision = { id: string; conversation_id: string; created_at: string; analyzed_msg_ts: string | null; intent: string | null };

export type EvalOptions = { nowMs?: number; dry?: boolean; days?: number; backlogDays?: number; limit?: number };
export type EvalResult = {
  ok: boolean; dry: boolean; judgeVersion: string;
  read: number; judged: number; pending: number; skippedFinal: number; updated: number; failed: number; orphans: number;
  verdicts: Record<string, number>; reasons: Record<string, number>; scenes: Record<string, number>;
  samples: Array<Record<string, unknown>>;
  errors: string[];
};

/**
 * 番の突き合わせ。直近 days 日（既定4日）の番は毎晩やり直す（窓が閉じるまで・規則の版が変わった時）＋ backlogDays 日の未判定の番。
 *   窓が閉じて同じ版で判定済みの番は読み直さない。
 */
export async function evaluateLineWatchTurns(sb: SupabaseClient, opt: EvalOptions = {}): Promise<EvalResult> {
  const nowMs = opt.nowMs ?? Date.now();
  const dry = !!opt.dry;
  const res: EvalResult = { ok: true, dry, judgeVersion: JUDGE_VERSION, read: 0, judged: 0, pending: 0, skippedFinal: 0, updated: 0, failed: 0, orphans: 0, verdicts: {}, reasons: {}, scenes: {}, samples: [], errors: [] };
  // 2段目の SQL（judge_version の列）を流す前でも回る（版の列なしで読み・書く。毎晩やり直すだけで中身は同じ）
  let hasVersionCol = true;
  const colsOf = (v: boolean) => `id, conversation_id, customer_turn_at, conv_status, draft_last, draft_last_at, draft_first, draft_first_at, draft_versions, draft_sentinel, brain_action, brain_reply_mode, brain_versions, tpo_label, verdict, verdict_detail, evaluated_at${v ? ", judge_version" : ""}`;
  const read = (v: boolean) => Promise.all([
    readAll<TurnRow>((f, t) => sb.from("line_watch_turns").select(colsOf(v)).gte("customer_turn_at", iso(nowMs - (opt.days ?? 4) * DAY)).order("customer_turn_at").order("id").range(f, t), opt.limit ?? 5000),
    readAll<TurnRow>((f, t) => sb.from("line_watch_turns").select(colsOf(v)).is("evaluated_at", null).gte("customer_turn_at", iso(nowMs - (opt.backlogDays ?? 30) * DAY)).order("customer_turn_at").order("id").range(f, t), opt.limit ?? 5000),
  ]);
  let recent: TurnRow[], backlog: TurnRow[];
  try { [recent, backlog] = await read(true); }
  catch (e) {
    if (!/judge_version/.test(e instanceof Error ? e.message : String(e))) throw e;
    hasVersionCol = false;
    res.errors.push("judge_version の列が無い（2段目の SQL を流す前）→ 版なしで判定");
    [recent, backlog] = await read(false);
  }
  const byId = new Map<number, TurnRow>();
  for (const r of [...recent, ...backlog]) byId.set(r.id, r);
  const turns = [...byId.values()].filter((t) => {
    const done = t.judge_version === JUDGE_VERSION && t.verdict_detail?.final === true && !!t.evaluated_at;
    if (done) res.skippedFinal++;
    return !done;
  });
  res.read = byId.size;
  if (!turns.length) return res;

  const convIds = [...new Set(turns.map((t) => t.conversation_id))];
  const since = iso(Math.min(...turns.map((t) => P(t.customer_turn_at))) - HOUR);
  const msgs: Msg[] = [], presses: Press[] = [], decisions: Decision[] = [];
  const existing = new Set<string>();
  for (let i = 0; i < convIds.length; i += 50) {
    const chunk = convIds.slice(i, i + 50);
    // 2026-10-07: お礼・了承の番の読むべき範囲（こちらの直前の返事・72時間以内）を決めるため、番の4日前から読む（窓の判定は番より後だけを見るので変わらない）
    msgs.push(...await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").in("conversation_id", chunk).gte("created_at", iso(P(since) - 4 * DAY)).order("created_at").order("id").range(f, t)));
    presses.push(...await readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").in("conversation_id", chunk).gte("created_at", since).not("aix_type", "is", null).order("created_at").order("id").range(f, t)));
    decisions.push(...await readAll<Decision>((f, t) => sb.from("brain_decision_logs").select("id, conversation_id, created_at, analyzed_msg_ts, intent:digest->>intent").in("conversation_id", chunk).gte("created_at", since).order("created_at").order("id").range(f, t)));
    const cv = await sb.from("conversations").select("id").in("id", chunk);
    if (cv.error) throw new Error(cv.error.message);
    for (const c of (cv.data ?? []) as Array<{ id: string }>) existing.add(c.id);
  }
  const group = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = group(msgs), pBy = group(presses), dBy = group(decisions);

  type Update = { id: number; patch: Record<string, unknown> };
  const updates: Update[] = [];
  const orphanIds: number[] = [];
  for (const t of turns) {
    if (!existing.has(t.conversation_id)) { orphanIds.push(t.id); continue; }
    const w = staffWindowOf({ customerTurnAt: t.customer_turn_at, msgs: mBy.get(t.conversation_id) ?? [], presses: pBy.get(t.conversation_id) ?? [], nowMs });
    // 2026-10-07 uran.: お礼・了承の番で下書きが読むべき範囲の外の行為を書いたか（下書きの欄が __SHOWN__ の時は最初の下書き）
    const upto = (mBy.get(t.conversation_id) ?? []).filter((m) => P(m.created_at) <= P(w.customerLastAt));
    // 2026-10-07: 下書きの欄が __SHOWN__（画面が表示した印）の番は draft_first で比べる（旧は返信の番の 39% を「印だけ」の na にしていた）
    const pick = pickJudgeDraft({ ...t, customer_last_at: w.customerLastAt });
    // 読むべき範囲の外の行為は前と同じく draft_first まで見る（uran. の見張り・スタッフが返さなかった番の数え方は変えない）
    const topicOut = outOfTopicActs(cleanDraft(t.draft_last).text ?? cleanDraft(t.draft_first).text, resolveAckTopicScope(upto));
    // 2026-10-08 返事を書いた人（直した所の表記→無ければ送った文全体の「確か」だけ）。STAFF_WRITER_SPLIT=off で渡さない
    const staffWriter = staffWriterSplitEnabled() ? staffWriterOfBurst(cleanDraft(pick.draft).text, w.texts.filter((x) => x.burst).map((x) => x.text).join("\n")) : null;
    const j = judgeTurn({
      draft: pick.draft, sentinel: t.draft_sentinel, brainAction: t.brain_action, brainReplyMode: t.brain_reply_mode,
      convStatus: t.conv_status, hasBrain: (t.brain_versions ?? 0) > 0, window: w, outOfTopicActs: topicOut, staffWriter,
    });
    if (topicOut.length && !j.detail.out_of_topic_acts) j.detail.out_of_topic_acts = topicOut;
    j.detail.draft_src = pick.src;
    const until = P(w.staffFirstAt ?? w.endAt);
    const dec = (dBy.get(t.conversation_id) ?? []).filter((d) => {
      const inTurn = d.analyzed_msg_ts ? P(d.analyzed_msg_ts) >= P(t.customer_turn_at) - 1000 && P(d.analyzed_msg_ts) <= P(w.customerLastAt) + 1000 : P(d.created_at) >= P(t.customer_turn_at);
      return inTurn && P(d.created_at) <= until;
    }).pop() ?? null;
    const scene = sceneKeyOf({ brainAction: t.brain_action, brainReplyMode: t.brain_reply_mode, tpoLabel: t.tpo_label, intent: dec?.intent ?? null, convStatus: t.conv_status });
    const draftAt = t.draft_last_at ?? t.draft_first_at;
    const patch: Record<string, unknown> = {
      staff_first_at: w.staffFirstAt,
      staff_texts: w.texts.map((x) => ({ at: x.at, burst: x.burst, text: x.text.slice(0, 2000) })),
      staff_aix: w.presses.map((p) => ({ aix_type: p.aix_type, check_pattern: p.check_pattern, at: p.at, burst: p.burst })),
      decision_id: dec?.id ?? null,
      verdict: j.verdict,
      verdict_detail: j.detail,
      scene_key: scene.key,
      draft_ready_before_staff: draftAt && w.staffFirstAt ? P(draftAt) <= P(w.staffFirstAt) : null,
      ...(hasVersionCol ? { judge_version: JUDGE_VERSION } : {}),
      evaluated_at: iso(nowMs),
    };
    updates.push({ id: t.id, patch });
    if (j.verdict) { res.judged++; res.verdicts[j.verdict] = (res.verdicts[j.verdict] ?? 0) + 1; } else res.pending++;
    res.reasons[j.detail.reason] = (res.reasons[j.detail.reason] ?? 0) + 1;
    res.scenes[scene.key] = (res.scenes[scene.key] ?? 0) + 1;
    if (res.samples.length < 12 && !isTestConversation(t.conversation_id)) {
      res.samples.push({ turn: t.id, conv: t.conversation_id.slice(0, 8), at: t.customer_turn_at, scene: scene.key, verdict: j.verdict, reason: j.detail.reason, draft: (pick.draft ?? "").slice(0, 60), staff: w.texts.filter((x) => x.burst).map((x) => x.text).join(" / ").slice(0, 60), aix: w.presses.map((p) => p.aix_type).join(",") });
    }
  }
  res.orphans = orphanIds.length;
  if (dry) return res;

  await withConcurrency(updates, 8, async (u) => {
    const { error } = await sb.from("line_watch_turns").update(u.patch).eq("id", u.id);
    if (error) { res.failed++; if (res.errors.length < 5) res.errors.push(error.message); } else res.updated++;
  });
  // 消えた会話の番（1段目の SQL の約束「消えた会話の行は2段目の掃除で消す」）
  if (orphanIds.length) {
    const { error } = await sb.from("line_watch_turns").delete().in("id", orphanIds);
    if (error) res.errors.push(`orphans: ${error.message}`);
  }
  res.ok = res.failed === 0;
  return res;
}

// ─────────────────────────────────────────────────────────────
// 毎日のまとめ
// ─────────────────────────────────────────────────────────────
type StatRow = StatTurn & { final_check: unknown; staff_first_at: string | null; verdict_review: string | null; verdict_review_verdict: string | null; verdict_review_rule: string | null; verdict_reviewed_at: string | null };

/** 申込ツールの DB（読むだけ）。環境変数が無い手元では null */
function screeningClient(): SupabaseClient | null {
  const url = process.env.SCREENING_ADMIN_SUPABASE_URL, key = process.env.SCREENING_ADMIN_SUPABASE_ANON_KEY;
  return url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
}

/** C7: こちらの内覧の予定（今日〜45日）と申込ツールの daily_tasks（同じ範囲）を照らす（申込ツールは読むだけ・コードは触らない） */
export async function checkScreeningCalendar(sb: SupabaseClient, nowMs: number): Promise<{ measured: boolean; reason?: string; findings: C7Finding[]; tasks?: number; ours?: number }> {
  const scr = screeningClient();
  if (!scr) return { measured: false, reason: "SCREENING_ADMIN_SUPABASE_URL／_ANON_KEY が無い（手元。本番のサーバーには有る）", findings: [] };
  const todayYmd = jstYmd(nowMs);
  const endYmd = jstYmd(nowMs + 45 * DAY);
  const ev = await sb.from("calendar_events").select("id, conversation_id, customer_name, event_type, title, start_at, all_day, notes, is_done")
    .eq("event_type", "viewing").gte("start_at", iso(jstDayStartMs(nowMs))).lte("start_at", iso(nowMs + 46 * DAY)).order("start_at").order("id").limit(2000);
  if (ev.error) return { measured: false, reason: `calendar_events: ${ev.error.message}`, findings: [] };
  const tk = await scr.from("daily_tasks").select("id, customer_name, content, date, time, end_time, done").gte("date", todayYmd).lte("date", endYmd).order("date").order("id").limit(3000);
  if (tk.error) return { measured: false, reason: `申込ツールの daily_tasks: ${tk.error.message}`, findings: [] };
  const ours = ((ev.data ?? []) as OurViewing[]).filter((e) => !e.conversation_id || !isTestConversation(e.conversation_id));
  const findings = screeningCalendarDiff({ ours, tasks: (tk.data ?? []) as ScreeningTask[], todayYmd });
  return { measured: true, findings, tasks: (tk.data ?? []).length, ours: ours.length };
}

/**
 * 2026-10-02 竹内「監視が防げる部分」: 直近24時間に送った文・予約中の文・今の下書き（24時間以内に更新）の機械の名残を探す。
 *   送信 API・予約送信の最後の網（outgoing-residue.ts）をすり抜けた物・網の前で止まった下書きを毎日のまとめに出す。テスト用の会話は数えない
 */
async function findOutgoingResidue(sb: SupabaseClient, nowMs: number): Promise<NonNullable<Parameters<typeof buildLineWatchDaily>[0]["residue"]>> {
  const out: NonNullable<Parameters<typeof buildLineWatchDaily>[0]["residue"]> = [];
  const since = iso(nowMs - DAY);
  const sent = await readAll<{ conversation_id: string; text: string | null }>((f, t) => sb.from("messages").select("conversation_id, text").eq("sender", "staff").gte("created_at", since).order("created_at").range(f, t), 10_000);
  const sch = await readAll<{ conversation_id: string | null; text: string | null }>((f, t) => sb.from("scheduled_messages").select("conversation_id, text").in("status", ["pending", "sending"]).range(f, t), 2_000);
  const drafts = await readAll<{ id: string; ai_draft: string | null }>((f, t) => sb.from("conversations").select("id, ai_draft").not("ai_draft", "is", null).gte("updated_at", since).range(f, t), 5_000);
  const push = (where: "sent" | "scheduled" | "draft", cid: string | null, text: string | null) => {
    if (cid && isTestConversation(cid)) return;
    const hits = detectOutgoingResidue(text);
    if (hits.length) out.push({ where, name: null, conversation_id: cid, labels: hits.map((h) => h.label) });
  };
  for (const m of sent) push("sent", m.conversation_id, m.text);
  for (const m of sch) push("scheduled", m.conversation_id, m.text);
  for (const c of drafts) push("draft", c.id, draftToSendableText(c.ai_draft));
  const ids = [...new Set(out.map((r) => r.conversation_id).filter((x): x is string => !!x))];
  if (ids.length) {
    const r = await sb.from("conversations").select("id, customer_name").in("id", ids.slice(0, 200));
    const nm = new Map(((r.data ?? []) as Array<{ id: string; customer_name: string | null }>).map((c) => [c.id, c.customer_name]));
    for (const o of out) o.name = o.conversation_id ? nm.get(o.conversation_id) ?? null : null;
  }
  return out;
}

export async function buildLineWatchDailyReport(sb: SupabaseClient, opt: { nowMs?: number } = {}) {
  const nowMs = opt.nowMs ?? Date.now();
  const errors: Record<string, string> = {};
  const date = jstYmd(nowMs);
  const dayStart = jstDayStartMs(nowMs);
  let rows: StatRow[] = [];
  const readTurns = (cols: string) => readAll<StatRow>((f, t) => sb.from("line_watch_turns").select(cols)
    .gte("customer_turn_at", iso(nowMs - 35 * DAY)).order("customer_turn_at").order("id").range(f, t), 20_000);
  const baseCols = "conversation_id, customer_turn_at, scene_key, verdict, verdict_detail, final_check, staff_first_at";
  try { rows = await readTurns(`${baseCols}, verdict_review, verdict_review_verdict, verdict_review_rule, verdict_reviewed_at`); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 👍✋の列は2段目の SQL を流した後から。流す前は列なしで数える（まとめは止めない）
    if (/verdict_review/.test(msg)) { try { rows = await readTurns(baseCols); errors.reviews = "👍✋の列が無い（2段目の SQL を流す前）"; } catch (e2) { errors.turns = e2 instanceof Error ? e2.message : String(e2); } }
    else errors.turns = msg;
  }
  const turns = rows.filter((r) => !isTestConversation(r.conversation_id));
  const scenes = sceneStats(turns, nowMs);
  const fc = finalCheckStats(turns, nowMs);
  const late = lateStats(turns, dayStart, nowMs);
  const reviews = reviewStats(turns.filter((t) => t.verdict_reviewed_at && nowMs - P(t.verdict_reviewed_at) < 28 * DAY));
  // 画面と同じ読み（約束・カレンダー C1〜C6・検索・AIX要対応・控えの様子）
  const watch = await loadLineWatch(sb, { nowMs });
  for (const [k, v] of Object.entries(watch.errors)) errors[`watch_${k}`] = v;
  const c7 = await checkScreeningCalendar(sb, nowMs).catch((e) => ({ measured: false, reason: e instanceof Error ? e.message : String(e), findings: [] as C7Finding[] }));
  // 前回のまとめ（場面の解禁／停止の変化を出す）
  let prevScenes: Array<{ scene: string; unlock: boolean; stop: boolean }> | null = null;
  {
    const pr = await sb.from("cron_run_logs").select("result_json, started_at").eq("cron_name", "line-watch-daily").not("result_json", "is", null).lt("started_at", iso(dayStart)).order("started_at", { ascending: false }).limit(1);
    const rj = (pr.data?.[0] as { result_json?: { daily?: { scenes?: Array<{ scene: string; unlock: boolean; stop: boolean }> } } } | undefined)?.result_json;
    prevScenes = rj?.daily?.scenes?.map((s) => ({ scene: s.scene, unlock: !!s.unlock, stop: !!s.stop })) ?? null;
  }
  const names = new Map<string, string | null>();
  {
    const ids = [...new Set(turns.filter((t) => P(t.customer_turn_at) >= nowMs - 2 * DAY).map((t) => t.conversation_id))];
    for (let i = 0; i < ids.length; i += 200) {
      const r = await sb.from("conversations").select("id, customer_name").in("id", ids.slice(i, i + 200));
      for (const c of (r.data ?? []) as Array<{ id: string; customer_name: string | null }>) names.set(c.id, c.customer_name);
    }
  }
  // 事実違い・AIX 違いを知らせる番＝24〜48時間前に来た番（窓は最長24時間なので全部閉じている・毎晩同じ時刻に回るので前回と重ならない）
  const dayTurns = turns.filter((t) => P(t.customer_turn_at) >= nowMs - 2 * DAY && P(t.customer_turn_at) < nowMs - DAY).map((t) => ({ ...t, name: names.get(t.conversation_id) ?? null }));
  let residue: Awaited<ReturnType<typeof findOutgoingResidue>> | undefined;
  try { residue = await findOutgoingResidue(sb, nowMs); } catch (e) { errors.residue = e instanceof Error ? e.message : String(e); }
  const daily = buildLineWatchDaily({
    date, scenes, prevScenes, fc, late, dayTurns, reviews, residue,
    promises: watch.promises.map((p) => ({ name: p.name, kindJa: p.kindJa, hours: p.hours, customerActive: p.customerActive })),
    calendar: watch.calendar.map((c) => ({ code: c.code })),
    c7, search: watch.search, aixPending: watch.aixItems.length,
    capture: { enabled: watch.capture.enabled, turns24h: watch.capture.turns24h, tableReady: watch.capture.tableReady },
    aixLabels: BRAIN_AIX_LABELS,
  });
  return { ok: Object.keys(errors).length === 0, date, daily, lines: dailyLines(daily, BRAIN_AIX_LABELS), turnsRead: rows.length, c7Detail: c7, errors };
}
export type LineWatchDailyReport = Awaited<ReturnType<typeof buildLineWatchDailyReport>>;
