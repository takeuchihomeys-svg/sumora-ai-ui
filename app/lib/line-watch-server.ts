// app/lib/line-watch-server.ts
// LINE の見張り 1段目の読み取り（読むだけ・書き込みなし・LLM なし）。/api/line-watch から呼ぶ。設計 line-watch-design.md §6。
// 決まりは全部 app/lib/line-watch-turn.ts（純関数）。ここは DB から材料を集めて渡すだけ。
// ⚠ 読み取りが1つ失敗しても他の欄は出す（欄ごとに errors に積む）。控えの表がまだ無い間（本番に流す前）も画面は開く
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  sceneKeyOf, compactFinalCheck, finalCheckLine, businessMinutesBetween, calendarChecks, openPromises, draftVsStaff,
  searchWatch, searchNeedReason, CAL_CODE_JA, PROMISE_JA, PROMISE_FULFILLED_BY,
  type WatchCalEvent, type FactRow, type SearchNeed, type AuditRow, type PickupRow, type CancelRequest,
} from "./line-watch-turn";
import { AUTO_REPLY_SKIP_STATUSES } from "./auto-reply-policy";
import { isTestConversation } from "./test-conversations";
import { BRAIN_AIX_LABELS } from "./aix-button-view";
import { hasViewingCancelRequestLine } from "./viewing-cancel-calendar";
// 2段目（2026-10-01）: 判定（保存済み＝毎晩の cron／まだの番はその場で同じ規則で仮に）・毎日のまとめ・場面ごとの一致率
import { staffWindowOf, judgeTurn, verdictLine, type Verdict, type VerdictDetail, type WindowPress } from "./line-watch-judge";
import { sceneStats, finalCheckStats, type StatTurn, type SceneStat, type FcStats } from "./line-watch-daily";
import { STAFF_ACT_JA } from "./customer-sim-shadow";
import { buildNewArrivalCards, stampLine, type NacPickupRow, type NacAudit } from "./new-arrival-card";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** 返信遅れの線（営業時間で数えて60分超を赤） */
export const LATE_MIN = 60;
/** 「今待っている」に出す番の古さの上限（それより前から止まっている会話は数だけ） */
const WAIT_WINDOW_MS = 3 * 24 * 3600_000;

type Msg = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };
type ConvLite = { id: string; customer_name: string | null; status: string | null; auto_send_enabled: boolean | null; property_customer_id: string | null };

const iso = (ms: number) => new Date(ms).toISOString();
const head = (s: string | null | undefined, n = 80) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const aixLabel = (a: string | null | undefined) => (a ? BRAIN_AIX_LABELS[a] ?? `AIX ${a}` : "");

/** 範囲で読む（1,000件ずつ・一意の列で終える＝設計知見「range の並びは一意の列で終える」） */
async function readAll<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, max = 5000): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  for (let i = 0; i < max; i += 1000) {
    const r = await q(i, i + 999);
    if (r.error) return { rows, error: r.error.message };
    const d = (r.data ?? []) as T[];
    rows.push(...d);
    if (d.length < 1000) break;
  }
  return { rows, error: null };
}

async function convsByIds(sb: SupabaseClient, ids: string[]): Promise<Map<string, ConvLite>> {
  const out = new Map<string, ConvLite>();
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 200) {
    const r = await sb.from("conversations").select("id, customer_name, status, auto_send_enabled, property_customer_id").in("id", uniq.slice(i, i + 200));
    for (const c of (r.data ?? []) as ConvLite[]) out.set(c.id, c);
  }
  return out;
}

async function messagesOf(sb: SupabaseClient, ids: string[], sinceIso: string, senders?: string[]): Promise<{ rows: Msg[]; error: string | null }> {
  const all: Msg[] = [];
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    const r = await readAll<Msg>((from, to) => {
      let q = sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").in("conversation_id", chunk).gte("created_at", sinceIso);
      if (senders) q = q.in("sender", senders);
      return q.order("created_at").order("id").range(from, to);
    });
    if (r.error) return { rows: all, error: r.error };
    all.push(...r.rows);
  }
  return { rows: all, error: null };
}

/** 会話の最後のお客様の連投の始まり（最後のスタッフの発言より後で一番古いお客様の発言）。最後がスタッフなら null */
function openTurnOf(msgs: ReadonlyArray<Msg>): { start: string; last: string; text: string } | null {
  let i = msgs.length - 1;
  if (i < 0 || msgs[i].sender !== "customer") return null;
  const last = msgs[i].created_at;
  while (i - 1 >= 0 && msgs[i - 1].sender === "customer") i--;
  return { start: msgs[i].created_at, last, text: msgs.slice(i).map((m) => m.text ?? "").join("\n") };
}

export type LineWatchOptions = {
  includeTest?: boolean; nowMs?: number;
  /** 「AI の案と実際」を何日分出すか（1〜7・既定1＝24時間）。👍✋で物差しを直す時は長めに */
  turnDays?: number;
  /** 場面ごとの一致率・最終チェックを今の控えから計算する（既定は毎晩のまとめの結果を出すだけ＝重い読みをしない） */
  live?: boolean;
};

export async function loadLineWatch(sb: SupabaseClient, opt: LineWatchOptions = {}) {
  const nowMs = opt.nowMs ?? Date.now();
  const errors: Record<string, string> = {};
  const keep = (cid: string | null | undefined) => !!cid && (opt.includeTest || !isTestConversation(cid));

  // ── 見張りの設定・控えの様子 ──
  const capture: { enabled: boolean | null; lastTurnAt: string | null; turns24h: number; tableReady: boolean; note: string | null } = { enabled: null, lastTurnAt: null, turns24h: 0, tableReady: false, note: null };
  {
    const s = await sb.from("line_watch_settings").select("capture_enabled, note").eq("id", 1).maybeSingle();
    if (s.error) { errors.capture = `設定の表が読めない（本番に流す前？）: ${s.error.message}`; }
    else { capture.enabled = (s.data as { capture_enabled?: boolean } | null)?.capture_enabled ?? null; capture.note = (s.data as { note?: string | null } | null)?.note ?? null; }
    const t = await sb.from("line_watch_turns").select("updated_at", { count: "exact" }).gte("updated_at", iso(nowMs - DAY)).order("updated_at", { ascending: false }).limit(1);
    if (!t.error) { capture.tableReady = true; capture.turns24h = t.count ?? 0; capture.lastTurnAt = (t.data?.[0] as { updated_at?: string } | undefined)?.updated_at ?? null; }
  }

  // ── 1. 今待っているお客様 ──
  type WaitRow = {
    id: string; name: string | null; status: string | null; auto: boolean; turnAt: string; lastAt: string; businessMin: number; late: boolean;
    scene: string; brain: string; replyMode: string | null; draftHead: string; sentinel: string | null; draftReady: boolean; finalCheck: string; blocks: number; isTest: boolean;
  };
  const waiting: WaitRow[] = [];
  let waitingOutOfScope = 0;
  let waitingStale = 0;
  {
    const r = await sb.from("conversations")
      .select("id, customer_name, status, auto_send_enabled, ai_draft, last_sender, updated_at, is_post_apply, brain_action:suggested_aix_meta->>action, reply_mode:suggested_aix_meta->>reply_mode, tpo:ai_draft_check->tpo_debug->>tpo_label, fc_ok:ai_draft_check->ok, fc_issues:ai_draft_check->issues, fc_pre:ai_draft_check->pre_revision_issues")
      .eq("last_sender", "customer").gte("updated_at", iso(nowMs - 14 * DAY)).order("updated_at", { ascending: false }).limit(300);
    if (r.error) errors.waiting = r.error.message;
    const convs = ((r.data ?? []) as Array<Record<string, unknown>>).filter((c) => keep(String(c.id)));
    const inScope = convs.filter((c) => {
      const out = AUTO_REPLY_SKIP_STATUSES.has(String(c.status ?? "")) || c.is_post_apply === true;
      if (out) waitingOutOfScope++;
      return !out;
    });
    const m = await messagesOf(sb, inScope.map((c) => String(c.id)), iso(nowMs - 14 * DAY));
    if (m.error) errors.waiting_messages = m.error;
    const byConv = new Map<string, Msg[]>();
    for (const x of m.rows) byConv.set(x.conversation_id, [...(byConv.get(x.conversation_id) ?? []), x]);
    for (const c of inScope) {
      const id = String(c.id);
      const turn = openTurnOf(byConv.get(id) ?? []);
      if (!turn) continue; // last_sender と messages が食い違う（送信の途中等）は出さない
      // 3日より前から止まっている会話は「今待っている」でなく数だけ（本番 10/1: 14日で見ると 5日前のお礼の一言等が上に並んだ）
      if (nowMs - Date.parse(turn.start) > WAIT_WINDOW_MS) { waitingStale++; continue; }
      const draft = String(c.ai_draft ?? "");
      const sentinel = /^\s*\[[^\]]{1,30}\]\s*$/.test(draft) ? draft.trim() : null;
      const noReplyNeeded = sentinel === "[返信不要]";
      const fc = compactFinalCheck({ ok: c.fc_ok, issues: c.fc_issues, pre: c.fc_pre });
      const scene = sceneKeyOf({ brainAction: c.brain_action as string | null, brainReplyMode: c.reply_mode as string | null, tpoLabel: c.tpo as string | null, convStatus: c.status as string | null });
      const bm = businessMinutesBetween(turn.start, nowMs);
      waiting.push({
        id, name: (c.customer_name as string | null) ?? null, status: (c.status as string | null) ?? null, auto: c.auto_send_enabled === true,
        turnAt: turn.start, lastAt: turn.last, businessMin: bm, late: bm > LATE_MIN && !noReplyNeeded,
        scene: scene.label, brain: scene.path === "AIX" ? aixLabel(String(c.brain_action ?? "")) || scene.label : "返信", replyMode: (c.reply_mode as string | null) ?? null,
        draftHead: sentinel ? "" : head(draft), sentinel, draftReady: !!draft.trim() && !sentinel, finalCheck: sentinel || !draft.trim() ? "" : finalCheckLine(fc), blocks: fc?.blocks ?? 0,
        isTest: isTestConversation(id),
      });
    }
    waiting.sort((a, b) => b.businessMin - a.businessMin || a.turnAt.localeCompare(b.turnAt));
  }

  // ── 2. AI の案と実際（直近 turnDays 日の番・控えの表から） ──
  //   2段目: 判定は毎晩の cron（line-watch-eval）が書いた物を出す。まだの番（今日の番）は同じ規則（judgeTurn）でその場で仮に出す（書かない）
  type TurnRow = {
    id: number | null; conversationId: string; name: string | null; turnAt: string; scene: string; brain: string; draftVersions: number; draftHead: string; sentinel: string | null;
    draftAt: string | null; staffHead: string; staffAt: string | null; staffAix: boolean; compare: string; sim: number | null; kinds: string[]; draftBeforeStaff: boolean | null; finalCheck: string;
    verdict: Verdict | null; verdictStored: boolean; verdictText: string; reason: string | null; factDiff: boolean; uncertain: boolean;
    review: string | null; reviewVerdict: string | null; reviewNote: string | null;
  };
  const turns: TurnRow[] = [];
  const turnDays = Math.min(7, Math.max(1, Math.floor(opt.turnDays ?? 1)));
  let reviewReady = false;
  if (capture.tableReady) {
    const base = "id, conversation_id, customer_turn_at, customer_last_at, conv_status, draft_first, draft_last, draft_last_at, draft_versions, draft_sentinel, brain_action, brain_reply_mode, brain_versions, tpo_label, final_check, verdict, verdict_detail";
    const q = (cols: string) => sb.from("line_watch_turns").select(cols)
      .gte("customer_turn_at", iso(nowMs - turnDays * DAY)).order("customer_turn_at", { ascending: false }).order("id").limit(turnDays > 1 ? 600 : 300);
    // 👍✋の列は2段目の SQL を流した後から（流す前は列なしで読む＝画面は開く）
    let r = await q(`${base}, verdict_review, verdict_review_verdict, verdict_review_note`);
    if (r.error) r = await q(base); else reviewReady = true;
    if (r.error) errors.turns = r.error.message;
    const rows = ((r.data ?? []) as unknown as Array<Record<string, unknown>>).filter((t) => keep(String(t.conversation_id)));
    const ids = rows.map((t) => String(t.conversation_id));
    const names = await convsByIds(sb, ids);
    const since = rows.reduce((m, t) => Math.min(m, Date.parse(String(t.customer_turn_at))), nowMs);
    const m = await messagesOf(sb, ids, iso(since - HOUR));
    if (m.error) errors.turns_messages = m.error;
    const byConv = new Map<string, Msg[]>();
    for (const x of m.rows) byConv.set(x.conversation_id, [...(byConv.get(x.conversation_id) ?? []), x]);
    // 押した AIX（仮の判定に使う）
    const pressBy = new Map<string, WindowPress[]>();
    {
      const uniq = [...new Set(ids)];
      for (let i = 0; i < uniq.length; i += 100) {
        const pr = await sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").in("conversation_id", uniq.slice(i, i + 100)).gte("created_at", iso(since - HOUR)).not("aix_type", "is", null).order("created_at").limit(2000);
        if (pr.error) { errors.turns_aix = pr.error.message; break; }
        for (const p of (pr.data ?? []) as Array<WindowPress & { conversation_id: string }>) pressBy.set(p.conversation_id, [...(pressBy.get(p.conversation_id) ?? []), p]);
      }
    }
    for (const t of rows) {
      const cid = String(t.conversation_id);
      const msgs = byConv.get(cid) ?? [];
      // 番の窓と返事のまとまり（line-watch-judge.ts の staffWindowOf＝cron と同じ切り方）
      const w = staffWindowOf({ customerTurnAt: String(t.customer_turn_at), msgs, presses: pressBy.get(cid) ?? [], nowMs });
      const burst = w.texts.filter((x) => x.burst);
      const staffText = burst.map((x) => x.text).join("\n").trim();
      const staffAix = w.presses.length > 0 || w.aixMessages > 0;
      const cmp = draftVsStaff(t.draft_last as string | null, staffText, t.draft_sentinel as string | null);
      const scene = sceneKeyOf({ brainAction: t.brain_action as string | null, brainReplyMode: t.brain_reply_mode as string | null, tpoLabel: t.tpo_label as string | null, convStatus: t.conv_status as string | null });
      const staffAt = w.staffFirstAt;
      const draftAt = (t.draft_last_at as string | null) ?? null;
      const stored = (t.verdict as Verdict | null) ?? null;
      const live = stored ? null : judgeTurn({
        draft: t.draft_last as string | null, sentinel: t.draft_sentinel as string | null, brainAction: t.brain_action as string | null, brainReplyMode: t.brain_reply_mode as string | null,
        convStatus: t.conv_status as string | null, hasBrain: Number(t.brain_versions ?? 0) > 0, window: w,
      });
      const verdict = stored ?? live?.verdict ?? null;
      const detail = (stored ? (t.verdict_detail as VerdictDetail | null) : live?.detail) ?? null;
      turns.push({
        id: typeof t.id === "number" ? t.id : Number(t.id) || null,
        conversationId: cid, name: names.get(cid)?.customer_name ?? null, turnAt: String(t.customer_turn_at), scene: scene.label,
        brain: scene.path === "AIX" ? aixLabel(String(t.brain_action ?? "")) || scene.label : "返信",
        draftVersions: Number(t.draft_versions ?? 0), draftHead: head(t.draft_last as string | null, 120), sentinel: (t.draft_sentinel as string | null) ?? null, draftAt,
        staffHead: head(staffText, 120), staffAt, staffAix,
        compare: staffAix && !staffText ? "aix_only" : cmp.kind, sim: cmp.sim, kinds: cmp.diff?.kinds ?? [],
        draftBeforeStaff: draftAt && staffAt ? Date.parse(draftAt) <= Date.parse(staffAt) : null,
        finalCheck: finalCheckLine(compactFinalCheck(t.final_check)),
        verdict, verdictStored: !!stored, verdictText: verdictLine(verdict, detail, STAFF_ACT_JA), reason: detail?.reason ?? null,
        factDiff: !!detail?.fact_diff, uncertain: !!detail?.uncertain,
        review: (t.verdict_review as string | null) ?? null, reviewVerdict: (t.verdict_review_verdict as string | null) ?? null, reviewNote: (t.verdict_review_note as string | null) ?? null,
      });
    }
  }

  // ── 3. 約束の未対応（sent_facts・14日） ──
  type PromiseRow = { conversationId: string; name: string | null; kind: string; kindJa: string; sentAt: string; hours: number; evidence: string | null; customerActive: boolean };
  const promises: PromiseRow[] = [];
  {
    const kinds = [...Object.keys(PROMISE_FULFILLED_BY), ...Object.values(PROMISE_FULFILLED_BY).flat()];
    const r = await readAll<FactRow>((from, to) => sb.from("sent_facts").select("conversation_id, kind, status, sent_at, evidence").in("kind", kinds).gte("sent_at", iso(nowMs - 14 * DAY)).order("sent_at").order("id").range(from, to));
    if (r.error) errors.promises = r.error;
    const facts = r.rows.filter((f) => keep(f.conversation_id));
    const promisedIds = [...new Set(facts.filter((f) => PROMISE_FULFILLED_BY[f.kind]).map((f) => f.conversation_id))];
    const cm = await messagesOf(sb, promisedIds, iso(nowMs - 14 * DAY), ["customer"]);
    const lastCustomerAt = new Map<string, string>();
    for (const x of cm.rows) if (!lastCustomerAt.has(x.conversation_id) || x.created_at > lastCustomerAt.get(x.conversation_id)!) lastCustomerAt.set(x.conversation_id, x.created_at);
    const open = openPromises({ facts, lastCustomerAt, nowMs });
    const names = await convsByIds(sb, open.map((p) => p.conversation_id));
    for (const p of open) {
      const c = names.get(p.conversation_id);
      if (c && AUTO_REPLY_SKIP_STATUSES.has(String(c.status ?? ""))) continue;
      promises.push({ conversationId: p.conversation_id, name: c?.customer_name ?? null, kind: p.kind, kindJa: PROMISE_JA[p.kind] ?? p.kind, sentAt: p.sent_at, hours: p.hours, evidence: head(p.evidence, 60) || null, customerActive: p.customerActive });
    }
  }

  // ── 4. AIX要対応（グループと同じ物・画面にだけ出す） ──
  type AixItem = { conversationId: string; name: string | null; action: string; label: string; checkPattern: string | null; createdAt: string };
  const aixItems: AixItem[] = [];
  {
    const r = await sb.from("aix_action_items").select("conversation_id, customer_name, action, check_pattern, created_at").eq("status", "pending").order("created_at", { ascending: false }).limit(100);
    if (r.error) errors.aix = r.error.message;
    for (const a of (r.data ?? []) as Array<{ conversation_id: string; customer_name: string | null; action: string; check_pattern: string | null; created_at: string }>) {
      if (!keep(a.conversation_id)) continue;
      aixItems.push({ conversationId: a.conversation_id, name: a.customer_name, action: a.action, label: aixLabel(a.action), checkPattern: a.check_pattern, createdAt: a.created_at });
    }
  }

  // ── 5. カレンダー（C1〜C6） ──
  type CalRow = { code: string; codeJa: string; conversationId: string | null; name: string | null; day: string | null; detail: string; eventIds: Array<number | string> };
  const calendar: CalRow[] = [];
  const deletions: Array<{ conversationId: string | null; eventId: string; reason: string | null; deletedAt: string }> = [];
  {
    const ev = await sb.from("calendar_events").select("id, conversation_id, event_type, title, start_at, end_at, all_day, is_done, notes, created_at")
      .eq("event_type", "viewing").gte("start_at", iso(nowMs - 14 * DAY)).lte("start_at", iso(nowMs + 45 * DAY)).order("start_at").order("id").limit(1000);
    if (ev.error) errors.calendar = ev.error.message;
    const events = ((ev.data ?? []) as WatchCalEvent[]).filter((e) => !e.conversation_id || keep(e.conversation_id));
    // 待ち合わせは予定を読む期間（14日前〜）と同じ所から（それより前の送信は予定を読んでいないので C1 に当てない）
    const mf = await sb.from("sent_facts").select("conversation_id, sent_at").eq("kind", "meeting_place_sent").gte("sent_at", iso(nowMs - 14 * DAY)).order("sent_at").limit(1000);
    if (mf.error) errors.calendar_meetings = mf.error.message;
    const meetings = ((mf.data ?? []) as Array<{ conversation_id: string; sent_at: string }>).filter((x) => keep(x.conversation_id));
    // 取りやめ: 今日以降の予定がある会話のお客様の発言（予定を作った日以降）に取りやめの行があるか
    const todayStart = nowMs - ((nowMs + 9 * HOUR) % DAY);
    const futureConvs = [...new Set(events.filter((e) => e.conversation_id && !e.is_done && Date.parse(e.start_at) >= todayStart).map((e) => e.conversation_id as string))];
    const cm = await messagesOf(sb, futureConvs, iso(nowMs - 14 * DAY), ["customer"]);
    const cancelRequests: CancelRequest[] = cm.rows.filter((x) => hasViewingCancelRequestLine(x.text)).map((x) => ({ conversation_id: x.conversation_id, at: x.created_at, text: x.text ?? "" }));
    const found = calendarChecks({ events, meetings, cancelRequests, nowMs });
    const names = await convsByIds(sb, found.map((f) => f.conversation_id ?? ""));
    for (const f of found) calendar.push({ code: f.code, codeJa: CAL_CODE_JA[f.code], conversationId: f.conversation_id, name: f.conversation_id ? names.get(f.conversation_id)?.customer_name ?? null : null, day: f.day, detail: f.detail, eventIds: f.event_ids });
    const del = await sb.from("calendar_event_deletions").select("conversation_id, event_id, reason, deleted_at").gte("deleted_at", iso(nowMs - 30 * DAY)).order("deleted_at", { ascending: false }).limit(50);
    if (!del.error) for (const d of (del.data ?? []) as Array<{ conversation_id: string | null; event_id: string; reason: string | null; deleted_at: string }>) {
      if (d.conversation_id && !keep(d.conversation_id)) continue;
      deletions.push({ conversationId: d.conversation_id, eventId: d.event_id, reason: d.reason, deletedAt: d.deleted_at });
    }
  }

  // ── 6. 物件検索 ──
  type SearchRow = { kind: "idle" | "empty" | "ready" | "short"; conversationId: string | null; name: string | null; at: string; detail: string };
  const search: SearchRow[] = [];
  {
    const needs: SearchNeed[] = [];
    const cr = await sb.from("conversations")
      .select("id, customer_name, status, property_customer_id, brain_analyzed_at, change_scope:suggested_aix_meta->>condition_change_scope, change_type:suggested_aix_meta->>condition_change_type")
      .gte("brain_analyzed_at", iso(nowMs - 7 * DAY)).limit(1000);
    if (cr.error) errors.search_needs = cr.error.message;
    for (const c of (cr.data ?? []) as Array<Record<string, unknown>>) {
      const cid = String(c.id);
      if (!keep(cid) || AUTO_REPLY_SKIP_STATUSES.has(String(c.status ?? ""))) continue;
      const reason = searchNeedReason({ change_scope: c.change_scope, change_type: c.change_type });
      if (reason) needs.push({ conversation_id: cid, property_customer_id: (c.property_customer_id as string | null) ?? null, at: String(c.brain_analyzed_at), reason });
    }
    const au = await readAll<AuditRow>((from, to) => sb.from("search_audits").select("property_customer_id, created_at, status, site, result").gte("created_at", iso(nowMs - 7 * DAY)).order("created_at").order("id").range(from, to), 3000);
    if (au.error) errors.search_audits = au.error;
    const audits = au.rows.map((a) => ({ ...a, result: a.result && typeof a.result === "object" ? { sendable_rows: (a.result as Record<string, unknown>).sendable_rows ?? null } : null }));
    const pk = await readAll<PickupRow>((from, to) => sb.from("property_pickups").select("conversation_id, created_at, status, complete_group_id, sent_at, expired_at").gte("created_at", iso(nowMs - 3 * DAY)).not("complete_group_id", "is", null).order("created_at").order("id").range(from, to), 5000);
    if (pk.error) errors.search_pickups = pk.error;
    const sw = searchWatch({ needs, audits, pickups: pk.rows.filter((p) => keep(p.conversation_id)), nowMs });
    // 送れる物件0 は property_customer_id → 会話
    const pcIds = sw.empty.map((e) => e.property_customer_id);
    const pcConv = new Map<string, ConvLite>();
    for (let i = 0; i < pcIds.length; i += 200) {
      const r = await sb.from("conversations").select("id, customer_name, status, auto_send_enabled, property_customer_id").in("property_customer_id", pcIds.slice(i, i + 200));
      for (const c of (r.data ?? []) as ConvLite[]) if (c.property_customer_id) pcConv.set(c.property_customer_id, c);
    }
    const names = await convsByIds(sb, [...sw.idle.map((n) => n.conversation_id), ...sw.ready.map((x) => x.conversation_id)]);
    for (const n of sw.idle) search.push({ kind: "idle", conversationId: n.conversation_id, name: names.get(n.conversation_id)?.customer_name ?? null, at: n.at, detail: `${n.reason}の後に検索なし${n.lastSearchAt ? `（前の検索 ${n.lastSearchAt.slice(5, 10)}）` : "（記録なし）"}` });
    for (const e of sw.empty) {
      const c = pcConv.get(e.property_customer_id);
      if (c && !keep(c.id)) continue;
      search.push({ kind: "empty", conversationId: c?.id ?? null, name: c?.customer_name ?? null, at: e.at, detail: `最新の検索（${e.site ?? "?"}）で送れる物件0` });
    }
    for (const x of sw.ready) search.push({ kind: "ready", conversationId: x.conversation_id, name: names.get(x.conversation_id)?.customer_name ?? null, at: x.latestAt, detail: `送れる資料 ${x.count}件` });

    // 2026-10-01 竹内（チンシャン・初回で送れる通す0件・ITANDI 未検索）「LINE の監視はこのような場合、物件検索のブレイン側に初回なので、
    //   もっと通す物件が必要と伝えなくてはいけない」: 初回の回（新規）で送れる「通す」（商談中・審査中を除く）が目安10件に足りない会話を出し、
    //   まだしていない検索（サイト × ピンポイント／広げて）を書く。判定はトークの物件カードと同じ buildNewArrivalCards（四者同名）
    try {
      const rk = await sb.from("property_pickups")
        .select("id, created_at, batch_id, site, verdict, status, seen_at, sent_at, search_mode, search_override, complete_group_id, property_customer_id, conversation_id, property_name, room_no, trim_image_url, terms")
        .gte("created_at", iso(nowMs - 2 * DAY)).not("conversation_id", "is", null).order("created_at", { ascending: false }).limit(3000);
      if (rk.error) errors.search_first_round = rk.error.message;
      const byConv = new Map<string, Array<NacPickupRow & { property_customer_id: string | null; conversation_id: string | null }>>();
      for (const r of (rk.data ?? []) as Array<NacPickupRow & { property_customer_id: string | null; conversation_id: string | null }>) {
        if (!r.conversation_id || !keep(r.conversation_id)) continue;
        byConv.set(r.conversation_id, [...(byConv.get(r.conversation_id) ?? []), r]);
      }
      const pcs = [...new Set([...byConv.values()].map((rs) => rs[0]?.property_customer_id).filter((x): x is string => !!x))];
      const audBy = new Map<string, NacAudit[]>();
      for (let i = 0; i < pcs.length; i += 200) {
        const a = await sb.from("search_audits").select("property_customer_id, created_at, site, is_wide, intended, customer_snapshot")
          .in("property_customer_id", pcs.slice(i, i + 200)).gte("created_at", iso(nowMs - 2 * DAY - 3 * 3600_000)).limit(3000);
        for (const x of (a.data ?? []) as Array<NacAudit & { property_customer_id: string }>) audBy.set(x.property_customer_id, [...(audBy.get(x.property_customer_id) ?? []), x]);
      }
      const shortConvs = [...byConv.keys()];
      const nm = await convsByIds(sb, shortConvs);
      for (const [convId, rs] of byConv) {
        const cards = buildNewArrivalCards(rs, audBy.get(rs[0]?.property_customer_id ?? "") ?? []);
        const last = cards[cards.length - 1];
        if (!last || last.kind !== "新規" || !last.target || last.target.short <= 0 || last.confirm.state === "sent") continue;
        const todo = (last.stamps ?? []).flatMap((s) => [!s.pinpoint ? `${s.label}の🎯ピンポイント` : "", !s.widen ? `${s.label}の🔎広げて` : ""]).filter(Boolean);
        search.push({
          kind: "short", conversationId: convId, name: nm.get(convId)?.customer_name ?? null, at: last.last_at,
          detail: `初回なのに送れる通す ${last.target.pass}件（目安10件・あと${last.target.short}件${last.target.deal ? `・商談中/審査中 ${last.target.deal}件は数えない` : ""}）｜${stampLine(last.stamps ?? [])}${todo.length ? ` → 物件検索のブレインへ: ${todo.join("・")} がまだ` : " → 両サイトとも広げ済み: 保留の中から送れる物件を確かめる"}`,
        });
      }
    } catch (e) {
      errors.search_first_round = e instanceof Error ? e.message : String(e);
    }
  }

  // ── 7. 今日のまとめ（毎晩の cron line-watch-daily の最新の結果）・場面ごとの一致率・最終チェックの段ごと ──
  type DailyView = { startedAt: string; ok: boolean | null; date: string | null; lines: string[]; alerts: string[]; scenes: SceneStat[]; fc: FcStats | null; c7: { measured: boolean; reason?: string; findings: Array<Record<string, unknown>> } | null };
  let daily: DailyView | null = null;
  {
    const r = await sb.from("cron_run_logs").select("started_at, ok, result_json").eq("cron_name", "line-watch-daily").not("result_json", "is", null).order("started_at", { ascending: false }).limit(1);
    if (r.error) errors.daily = r.error.message;
    const row = (r.data?.[0] ?? null) as { started_at: string; ok: boolean | null; result_json: Record<string, unknown> | null } | null;
    const rj = row?.result_json as { date?: string; lines?: string[]; daily?: { alerts?: string[]; scenes?: SceneStat[]; fc?: FcStats; c7?: DailyView["c7"] } } | null;
    if (row && rj) daily = { startedAt: row.started_at, ok: row.ok, date: rj.date ?? null, lines: rj.lines ?? [], alerts: rj.daily?.alerts ?? [], scenes: rj.daily?.scenes ?? [], fc: rj.daily?.fc ?? null, c7: rj.daily?.c7 ?? null };
  }
  let liveStats: { scenes: SceneStat[]; fc: FcStats; turns: number } | null = null;
  if (opt.live && capture.tableReady) {
    const rows: Array<StatTurn & { final_check: unknown }> = [];
    const r = await readAll<StatTurn & { final_check: unknown }>((from, to) => sb.from("line_watch_turns").select("conversation_id, customer_turn_at, scene_key, verdict, verdict_detail, final_check")
      .gte("customer_turn_at", iso(nowMs - 35 * DAY)).order("customer_turn_at").order("id").range(from, to), 20_000);
    if (r.error) errors.live = r.error;
    rows.push(...r.rows.filter((t) => keep(t.conversation_id)));
    liveStats = { scenes: sceneStats(rows, nowMs), fc: finalCheckStats(rows, nowMs), turns: rows.length };
  }

  const summary = {
    waiting: waiting.length, late: waiting.filter((w) => w.late).length, waitingOutOfScope, waitingStale,
    turns: turns.length, promises: promises.filter((p) => p.customerActive).length, aix: aixItems.length,
    calendar: calendar.length, search: search.length,
  };
  return { ok: true as const, generatedAt: iso(nowMs), capture, summary, waiting, turns, turnDays, reviewReady, promises, aixItems, calendar, deletions, search, daily, liveStats, errors };
}
export type LineWatchPayload = Awaited<ReturnType<typeof loadLineWatch>>;
