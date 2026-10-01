// app/lib/line-watch-turn.ts
// LINE の見張り 1段目の決まり（純関数・DB も fetch も持たない）。設計 line-watch-design.md §3.3・§6。
// 2026-10-01 竹内「LINE の監視の部分にうつる、自動で行って YUMA でテスト」。
//
//   sceneKeyOf          … 番の場面（道＝AIX の種類 or 返信 ×返信の中は sceneFromTpo）。画面・2段目の cron・3段目の関所が同じ関数を使う（四者同名）
//   compactFinalCheck   … 最終チェックの指摘を段（ルール／異常／文脈／決定論／不明）ごとに（トリガーの小さな形と ai_draft_check の生の形の両方を受ける）
//   businessMinutesBetween … 営業時間（日本時間 10〜19時）だけで数えた経過（返信遅れの物差し）
//   calendarChecks      … カレンダーの点検 C1〜C6（こちら側の予定だけ。申込ツールの daily_tasks との突き合わせ C7 は2段目）
//   openPromises        … 約束の未対応（確認・ピックアップ・見積書の宣言で、果たした記録が無い物）
//   draftVsStaff        … AI の案とスタッフの実際（1段目は完全一致と似ている度だけ＝edit-diff の classifyEdit）
//   searchWatch         … 物件検索の見張り（検索が要るのに動いていない／検索したが送る物件が無い／送れる資料 N件）
// テスト: app/lib/__tests__/line-watch-turn.test.ts（本番の実物の行の形）
import { sceneFromTpo } from "./opener-rates";
import { normalizeAixForMatch } from "./brain-aix-feedback";
import { AUTO_REPLY_SKIP_STATUSES } from "./auto-reply-policy";
import { jstParts } from "./jst-date";
import { isOutingViewingNotes } from "./viewing-slot-plan";
import { isViewingHoldNotes } from "./viewing-hold";
import { wardOfAddress } from "./osaka-geo";
import { classifyEdit, type EditDiff } from "./edit-diff";

const JST_OFFSET_MS = 9 * 3600_000;
const MIN_MS = 60_000;

// ─────────────────────────────────────────────────────────────
// 場面
// ─────────────────────────────────────────────────────────────
export type SceneInput = {
  brainAction?: string | null;
  brainReplyMode?: string | null;
  tpoLabel?: string | null;
  /** ブレインの digest.intent 等（返信の場面が tpo で決まらない時だけ使う） */
  intent?: string | null;
  convStatus?: string | null;
};
export type SceneKey = { key: string; path: "AIX" | "返信" | "対象外"; label: string };

/** AIX の種類として読める action（古い行の自由文の action は AIX にしない） */
const AIX_ACTION_RE = /^[a-z][a-z0-9_]{1,60}$/;

/**
 * 番の場面。
 * - 申込以降の状態（自動送信を止める状態と同じ8つ）は「対象外」（審査落ちで戻した会話は状態が申込前に戻るので対象に入る）
 * - ブレインが AIX（reply_mode=aix か、reply_mode が無く AIX の種類の action）→ AIX:<種類>（2026-10-01 から acknowledge_check は寄せない＝normalizeAixForMatch）
 * - reply_mode=aix で action が空 → AIX:種類なし
 * - それ以外は返信: tpo_label の場面（6つ）→ 無ければ intent → 無ければ その他
 */
export function sceneKeyOf(i: SceneInput): SceneKey {
  const status = (i.convStatus ?? "").trim();
  if (status && AUTO_REPLY_SKIP_STATUSES.has(status)) return { key: "対象外:申込以降", path: "対象外", label: "申込以降（対象外）" };
  const action = (i.brainAction ?? "").trim();
  const mode = (i.brainReplyMode ?? "").trim();
  const validAction = action && action !== "null" && AIX_ACTION_RE.test(action) ? normalizeAixForMatch(action) : "";
  if (mode === "aix" || (!mode && validAction)) {
    if (validAction) return { key: `AIX:${validAction}`, path: "AIX", label: `AIX ${validAction}` };
    if (mode === "aix") return { key: "AIX:種類なし", path: "AIX", label: "AIX（種類なし）" };
  }
  const scene = sceneFromTpo(i.tpoLabel);
  if (scene && scene !== "その他") return { key: `返信:${scene}`, path: "返信", label: scene };
  const intent = (i.intent ?? "").trim();
  if (intent) return { key: `返信:意図:${intent}`, path: "返信", label: `意図: ${intent}` };
  return { key: "返信:その他", path: "返信", label: "その他" };
}

// ─────────────────────────────────────────────────────────────
// 最終チェックの指摘（段ごと）
// ─────────────────────────────────────────────────────────────
export type FcStage = "ルール" | "異常" | "文脈" | "決定論" | "その他" | "不明";
const PASS_STAGE: Record<string, FcStage> = { rule_check: "ルール", anomaly_scan: "異常", context_check: "文脈", meta: "その他" };
export type FcCode = { code: string; severity: string; stage: FcStage; evidence?: string };
export type CompactFc = {
  ok: boolean | null;
  /** 最後に残った指摘（段つき） */
  final: FcCode[];
  /** 修正前の指摘（記録に段が無いので、同じ code が最後にあればその段・_DET は決定論・他は不明） */
  pre: FcCode[];
  /** 段ごとの件数（最後の指摘） */
  byStage: Partial<Record<FcStage, number>>;
  blocks: number;
  revisionCount: number;
  revisionOutcome: string | null;
  passes: string[];
};

type RawIssue = { code?: unknown; pass?: unknown; severity?: unknown; evidence?: unknown };
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

function stageOfCode(code: string, pass: string | null, known: Map<string, FcStage>): FcStage {
  if (pass && PASS_STAGE[pass]) return PASS_STAGE[pass];
  if (/_DET$/.test(code)) return "決定論";
  return known.get(code) ?? "不明";
}

/**
 * トリガーが控えた小さな形（issues/pre/passes/revision_count/revision_outcome）と、conversations.ai_draft_check の生の形
 * （issues/pre_revision_issues/passes_completed/tpo_debug.revisionOutcome）の両方を受ける。読めなければ null
 */
export function compactFinalCheck(fc: unknown): CompactFc | null {
  if (!fc || typeof fc !== "object" || Array.isArray(fc)) return null;
  const o = fc as Record<string, unknown>;
  const tpo = (o.tpo_debug && typeof o.tpo_debug === "object" ? o.tpo_debug : {}) as Record<string, unknown>;
  const known = new Map<string, FcStage>();
  const final: FcCode[] = [];
  for (const x of asArr(o.issues)) {
    if (!x || typeof x !== "object") continue;
    const it = x as RawIssue;
    const code = str(it.code).trim();
    if (!code) continue;
    const stage = stageOfCode(code, str(it.pass) || null, known);
    known.set(code, stage);
    final.push({ code, severity: str(it.severity) || "warning", stage, evidence: str(it.evidence).slice(0, 120) || undefined });
  }
  const preRaw = asArr(o.pre ?? o.pre_revision_issues);
  const pre: FcCode[] = preRaw.map((p) => {
    const [code, sev] = str(p).split(":");
    const c = (code ?? "").trim();
    return { code: c, severity: (sev ?? "").trim() || "warning", stage: stageOfCode(c, null, known) };
  }).filter((p) => p.code);
  const byStage: Partial<Record<FcStage, number>> = {};
  for (const f of final) byStage[f.stage] = (byStage[f.stage] ?? 0) + 1;
  const ok = typeof o.ok === "boolean" ? o.ok : null;
  const rc = Number(o.revision_count ?? 0);
  const outcome = str(o.revision_outcome ?? tpo.revisionOutcome) || null;
  return {
    ok, final, pre, byStage,
    blocks: final.filter((f) => f.severity === "block").length,
    revisionCount: Number.isFinite(rc) ? rc : 0,
    revisionOutcome: outcome,
    passes: asArr(o.passes ?? o.passes_completed).map(str).filter(Boolean),
  };
}

/** 画面の1行（「文脈 MISSED_QUESTION・ルール NAME_MISMATCH（修正前 4件）」） */
export function finalCheckLine(c: CompactFc | null): string {
  if (!c) return "";
  const parts = c.final.map((f) => `${f.stage} ${f.code}${f.severity === "block" ? "（block）" : ""}`);
  const head = parts.length ? parts.join("・") : "指摘なし";
  return c.pre.length ? `${head}（修正前 ${c.pre.length}件）` : head;
}

// ─────────────────────────────────────────────────────────────
// 営業時間での経過
// ─────────────────────────────────────────────────────────────
export const BUSINESS_HOURS = { startHour: 10, endHour: 19 } as const;

/**
 * from〜to の間のうち、日本時間 startHour〜endHour の中にある分数（毎日同じ・休みの日は持たない）。
 * 夜に来た発言は翌朝10時から数える。to が from より前・読めない時は 0
 */
export function businessMinutesBetween(fromIso: string | number | Date, toIso: string | number | Date, hours: { startHour: number; endHour: number } = BUSINESS_HOURS): number {
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  let total = 0;
  // 日本時間の日の始まり（UTC ms）
  const dayStart = (ms: number) => Math.floor((ms + JST_OFFSET_MS) / 86_400_000) * 86_400_000 - JST_OFFSET_MS;
  for (let d = dayStart(a); d < b; d += 86_400_000) {
    const open = d + hours.startHour * 3600_000;
    const close = d + hours.endHour * 3600_000;
    const s = Math.max(a, open);
    const e = Math.min(b, close);
    if (e > s) total += (e - s) / MIN_MS;
  }
  return Math.floor(total);
}

// ─────────────────────────────────────────────────────────────
// カレンダーの点検（こちら側）
// ─────────────────────────────────────────────────────────────
export type WatchCalEvent = {
  id: number | string; conversation_id: string | null; event_type: string | null; title?: string | null;
  start_at: string; end_at?: string | null; all_day?: boolean | null; is_done?: boolean | null; notes: string | null; created_at?: string | null;
};
export type MeetingFact = { conversation_id: string; sent_at: string };
export type CancelRequest = { conversation_id: string; at: string; text?: string };
export type CalCode = "C1" | "C2" | "C3" | "C4" | "C5" | "C6";
export type CalFinding = { code: CalCode; conversation_id: string | null; event_ids: Array<number | string>; day: string | null; detail: string };

export const CAL_CODE_JA: Record<CalCode, string> = {
  C1: "待ち合わせを送ったのに内覧の予定が無い",
  C2: "待ち合わせの後も「物件: （未確定）」のまま",
  C3: "同じ日に同じお客様の内覧の予定が2つ以上",
  C4: "内覧の枠の外（11:00 前の開始・18:30 後の終了）",
  C5: "前後の予定の間が短い（区が違うのに2時間未満）",
  C6: "取りやめの発言があるのに今日以降の予定が残る",
};
/** 枠の決まり（feedback_viewing_slot_rules: 開始 11:00〜終了 18:30） */
export const VIEWING_SLOT = { startMin: 11 * 60, endMin: 18 * 60 + 30 } as const;
/** 終わりの時刻が無い予定の長さ（1件の内覧は約30分） */
const DEFAULT_VIEWING_MIN = 30;
/** 区が違う予定の間に要る時間（竹内さん「吹田→東大阪は2時間空ける」） */
export const FAR_GAP_MIN = 120;

const ymdOf = (iso: string) => { const p = jstParts(iso); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; };
const minOfDay = (iso: string) => { const p = jstParts(iso); return p.hour * 60 + p.minute; };
const hm = (iso: string) => { const p = jstParts(iso); return `${p.hour}:${String(p.minute).padStart(2, "0")}`; };
const endMsOf = (e: WatchCalEvent, defMin: number) => (e.end_at ? Date.parse(e.end_at) : Date.parse(e.start_at) + defMin * MIN_MS);
const isViewing = (e: WatchCalEvent) => e.event_type === "viewing";
const isUndecided = (e: WatchCalEvent) => /物件:\s*（未確定）/.test(e.notes ?? "");
const isMustNote = (e: WatchCalEvent) => /^\s*【必ず】/.test(e.notes ?? "");
function addressOf(notes: string | null | undefined): string | null {
  const m = (notes ?? "").match(/住所\s*[:：]\s*([^\n]+)/);
  return m ? m[1].trim() : null;
}

/**
 * C1〜C6。events は見る期間の予定（conversation_id の無い予定も C4・C5 には入る）。nowMs は今日以降の判定に使う
 */
export function calendarChecks(o: {
  events: ReadonlyArray<WatchCalEvent>;
  meetings?: ReadonlyArray<MeetingFact>;
  cancelRequests?: ReadonlyArray<CancelRequest>;
  nowMs?: number;
}): CalFinding[] {
  const nowMs = o.nowMs ?? Date.now();
  const out: CalFinding[] = [];
  const viewings = o.events.filter((e) => isViewing(e) && !isMustNote(e));
  const byConv = new Map<string, WatchCalEvent[]>();
  for (const e of viewings) if (e.conversation_id) byConv.set(e.conversation_id, [...(byConv.get(e.conversation_id) ?? []), e]);

  // C1・C2（待ち合わせの送信ごと・同じ会話は一番新しい送信だけ）
  const lastMeeting = new Map<string, string>();
  for (const m of o.meetings ?? []) if (!lastMeeting.has(m.conversation_id) || m.sent_at > lastMeeting.get(m.conversation_id)!) lastMeeting.set(m.conversation_id, m.sent_at);
  for (const [cid, sentAt] of lastMeeting) {
    const sentDay = ymdOf(sentAt);
    const after = (byConv.get(cid) ?? []).filter((e) => ymdOf(e.start_at) >= sentDay && !isViewingHoldNotes(e.notes));
    const decided = after.filter((e) => !isUndecided(e));
    if (decided.length === 0) out.push({ code: "C1", conversation_id: cid, event_ids: [], day: sentDay, detail: `待ち合わせ ${sentDay} ${hm(sentAt)} の後に決まった内覧の予定が無い` });
    const undecided = after.filter((e) => isUndecided(e) && !e.is_done);
    if (undecided.length) out.push({ code: "C2", conversation_id: cid, event_ids: undecided.map((e) => e.id), day: ymdOf(undecided[0].start_at), detail: `待ち合わせの後も未確定の予定 ${undecided.length}件（${undecided.map((e) => ymdOf(e.start_at).slice(5)).join("・")}）` });
  }

  // C3（時間確保・終日は除く）
  for (const [cid, evs] of byConv) {
    const days = new Map<string, WatchCalEvent[]>();
    for (const e of evs) {
      if (e.all_day || isViewingHoldNotes(e.notes)) continue;
      const d = ymdOf(e.start_at);
      days.set(d, [...(days.get(d) ?? []), e]);
    }
    for (const [d, list] of days) if (list.length >= 2) out.push({ code: "C3", conversation_id: cid, event_ids: list.map((e) => e.id), day: d, detail: `${d} に ${list.length}件（${list.map((e) => hm(e.start_at)).join("・")}）` });
  }

  // C4（時間確保も候補の枠なので入れる・未確定の自動の予定は日だけの物が多いので時刻のある物だけ）
  for (const e of viewings) {
    if (e.all_day) continue;
    const s = minOfDay(e.start_at);
    const endMs = endMsOf(e, DEFAULT_VIEWING_MIN);
    const endMin = s + Math.round((endMs - Date.parse(e.start_at)) / MIN_MS);
    if (s < VIEWING_SLOT.startMin || endMin > VIEWING_SLOT.endMin) {
      out.push({ code: "C4", conversation_id: e.conversation_id, event_ids: [e.id], day: ymdOf(e.start_at), detail: `${ymdOf(e.start_at).slice(5)} ${hm(e.start_at)}〜${hm(new Date(endMs).toISOString())}${isViewingHoldNotes(e.notes) ? "（時間確保）" : ""}` });
    }
  }

  // C5（決まった内覧＝住所がある物だけ・日ごとに時刻順・隣どうし）
  const outings = viewings.filter((e) => !e.all_day && isOutingViewingNotes(e.event_type, e.notes) && addressOf(e.notes));
  const outDays = new Map<string, WatchCalEvent[]>();
  for (const e of outings) { const d = ymdOf(e.start_at); outDays.set(d, [...(outDays.get(d) ?? []), e]); }
  for (const [d, list] of outDays) {
    const sorted = [...list].sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1], b = sorted[i];
      const wa = wardOfAddress(addressOf(a.notes)), wb = wardOfAddress(addressOf(b.notes));
      if (!wa || !wb || wa === wb) continue;
      const gap = Math.round((Date.parse(b.start_at) - endMsOf(a, DEFAULT_VIEWING_MIN)) / MIN_MS);
      if (gap < FAR_GAP_MIN) out.push({ code: "C5", conversation_id: b.conversation_id, event_ids: [a.id, b.id], day: d, detail: `${hm(a.start_at)} ${wa} → ${hm(b.start_at)} ${wb}（間 ${gap}分）` });
    }
  }

  // C6（取りやめの発言の後に作られた物でない・今日以降・済みでない・決まった内覧）
  const todayYmd = ymdOf(new Date(nowMs).toISOString());
  const lastCancel = new Map<string, CancelRequest>();
  for (const c of o.cancelRequests ?? []) if (!lastCancel.has(c.conversation_id) || c.at > lastCancel.get(c.conversation_id)!.at) lastCancel.set(c.conversation_id, c);
  for (const [cid, c] of lastCancel) {
    const left = (byConv.get(cid) ?? []).filter((e) => !e.is_done && !isViewingHoldNotes(e.notes) && ymdOf(e.start_at) >= todayYmd
      && (!e.created_at || e.created_at <= c.at));
    if (left.length) out.push({ code: "C6", conversation_id: cid, event_ids: left.map((e) => e.id), day: ymdOf(left[0].start_at), detail: `取りやめの発言（${ymdOf(c.at).slice(5)} ${hm(c.at)}${c.text ? `「${c.text.slice(0, 30)}」` : ""}）の後も予定 ${left.length}件` });
  }
  const order: CalCode[] = ["C6", "C1", "C2", "C3", "C5", "C4"];
  return out.sort((x, y) => order.indexOf(x.code) - order.indexOf(y.code) || String(x.day ?? "").localeCompare(String(y.day ?? "")));
}

// ─────────────────────────────────────────────────────────────
// 約束の未対応
// ─────────────────────────────────────────────────────────────
export type FactRow = { conversation_id: string; kind: string; status?: string | null; sent_at: string; evidence?: string | null };
/** 約束 → 果たした記録（sent_facts の kind）。見積書の宣言は送付で果たす・確認は報告・ピックアップは物件の送付 */
export const PROMISE_FULFILLED_BY: Readonly<Record<string, readonly string[]>> = {
  confirmation_promised: ["confirmation_reported"],
  pickup_declared: ["properties_sent"],
  estimate_declared: ["estimate_sent"],
};
export const PROMISE_JA: Record<string, string> = { confirmation_promised: "確認の約束", pickup_declared: "ピックアップの宣言", estimate_declared: "見積書の宣言" };
export type OpenPromise = { conversation_id: string; kind: string; sent_at: string; evidence: string | null; hours: number; customerActive: boolean };

/**
 * 果たした記録が無い約束（同じ会話で約束の後に果たした kind が無い）。同じ会話・同じ kind は一番新しい約束だけ。
 * customerActive = 約束の後にお客様の発言がある、または約束から activeHours 以内（お客様が止まっていない）
 */
export function openPromises(o: { facts: ReadonlyArray<FactRow>; lastCustomerAt?: ReadonlyMap<string, string>; nowMs?: number; activeHours?: number }): OpenPromise[] {
  const nowMs = o.nowMs ?? Date.now();
  const activeHours = o.activeHours ?? 72;
  const latest = new Map<string, FactRow>();
  for (const f of o.facts) {
    if (!PROMISE_FULFILLED_BY[f.kind]) continue;
    const k = `${f.conversation_id}|${f.kind}`;
    if (!latest.has(k) || f.sent_at > latest.get(k)!.sent_at) latest.set(k, f);
  }
  const res: OpenPromise[] = [];
  for (const p of latest.values()) {
    const done = o.facts.some((f) => f.conversation_id === p.conversation_id && PROMISE_FULFILLED_BY[p.kind].includes(f.kind) && f.sent_at >= p.sent_at);
    if (done) continue;
    const hours = Math.max(0, Math.floor((nowMs - Date.parse(p.sent_at)) / 3600_000));
    const lc = o.lastCustomerAt?.get(p.conversation_id);
    const customerActive = (lc != null && lc > p.sent_at) || hours <= activeHours;
    res.push({ conversation_id: p.conversation_id, kind: p.kind, sent_at: p.sent_at, evidence: p.evidence ?? null, hours, customerActive });
  }
  return res.sort((a, b) => b.hours - a.hours);
}

// ─────────────────────────────────────────────────────────────
// AI の案と実際（1段目は完全一致と似ている度だけ）
// ─────────────────────────────────────────────────────────────
export type DraftVsStaff = { kind: "same" | "edited" | "no_draft" | "no_staff" | "sentinel"; sim: number | null; diff: EditDiff | null };
export function draftVsStaff(draft: string | null | undefined, staff: string | null | undefined, sentinel?: string | null): DraftVsStaff {
  const d = (draft ?? "").trim();
  const s = (staff ?? "").trim();
  if (!s) return { kind: "no_staff", sim: null, diff: null };
  if (!d) return { kind: sentinel ? "sentinel" : "no_draft", sim: null, diff: null };
  const diff = classifyEdit(d, s);
  return { kind: diff.amount === "none" ? "same" : "edited", sim: Math.round(diff.sim * 100) / 100, diff };
}

// ─────────────────────────────────────────────────────────────
// 物件検索の見張り
// ─────────────────────────────────────────────────────────────
export type SearchNeed = { conversation_id: string; property_customer_id: string | null; at: string; reason: string };
export type AuditRow = { property_customer_id: string | null; created_at: string; status?: string | null; result?: Record<string, unknown> | null; site?: string | null };
export type PickupRow = { conversation_id: string | null; created_at: string; status?: string | null; complete_group_id?: string | null; sent_at?: string | null; expired_at?: string | null };
export type SearchWatch = {
  idle: Array<SearchNeed & { lastSearchAt: string | null }>;
  empty: Array<{ property_customer_id: string; at: string; site: string | null }>;
  ready: Array<{ conversation_id: string; count: number; latestAt: string }>;
};

/** ブレインの判断から「今検索が要るか」の手掛かり（条件の言い直し＝今回だけ／条件そのもの・検索の条件あり） */
export function searchNeedReason(hint: { change_scope?: unknown; change_type?: unknown; params?: unknown } | null | undefined): string | null {
  if (!hint || typeof hint !== "object") return null;
  const scope = str(hint.change_scope).trim();
  if (scope === "permanent") return "条件そのものの言い直し";
  if (scope === "temporary") return "今回だけの条件の調整";
  const type = str(hint.change_type).trim();
  if (type && type !== "none" && type !== "null") return `条件の変更（${type}）`;
  return null;
}

/**
 * idle = 検索が要る番の後に、そのお客様の検索（search_audits）が1回も無い（graceMin 分は待つ）
 * empty = そのお客様の最新の終わった検索で送れる物件が0（sendable_rows=0）
 * ready = ピックアップが終わって（complete_group_id あり）まだ送っていない資料の数（会話ごと）
 */
export function searchWatch(o: { needs: ReadonlyArray<SearchNeed>; audits: ReadonlyArray<AuditRow>; pickups: ReadonlyArray<PickupRow>; nowMs?: number; graceMin?: number }): SearchWatch {
  const nowMs = o.nowMs ?? Date.now();
  const grace = (o.graceMin ?? 30) * MIN_MS;
  const byCust = new Map<string, AuditRow[]>();
  for (const a of o.audits) if (a.property_customer_id) byCust.set(a.property_customer_id, [...(byCust.get(a.property_customer_id) ?? []), a]);
  const lastNeed = new Map<string, SearchNeed>();
  for (const n of o.needs) if (!lastNeed.has(n.conversation_id) || n.at > lastNeed.get(n.conversation_id)!.at) lastNeed.set(n.conversation_id, n);
  const idle: SearchWatch["idle"] = [];
  for (const n of lastNeed.values()) {
    if (nowMs - Date.parse(n.at) < grace) continue;
    const list = n.property_customer_id ? byCust.get(n.property_customer_id) ?? [] : [];
    const last = list.reduce<string | null>((m, a) => (!m || a.created_at > m ? a.created_at : m), null);
    if (!list.some((a) => a.created_at >= n.at)) idle.push({ ...n, lastSearchAt: last });
  }
  const empty: SearchWatch["empty"] = [];
  for (const [cid, list] of byCust) {
    const fin = list.filter((a) => (a.status ?? "finished") === "finished").sort((a, b) => b.created_at.localeCompare(a.created_at));
    const top = fin[0];
    if (top && top.result && Number((top.result as Record<string, unknown>).sendable_rows) === 0 && (top.result as Record<string, unknown>).sendable_rows !== null) {
      empty.push({ property_customer_id: cid, at: top.created_at, site: top.site ?? null });
    }
  }
  // まとめ（complete_group_id）ごと: 1件でも送ったまとめは「送った後の残り」なので数えない（残りは送らない物＝送れる資料ではない）。
  //   会話ごとに一番新しいまとめで、まだ1件も送っていない物だけ（本番 9/30: 送った後の残りまで数えると 1人 74件 等に膨らんだ）
  const groups = new Map<string, { conversation_id: string; count: number; latestAt: string; anySent: boolean }>();
  for (const p of o.pickups) {
    if (!p.conversation_id || !p.complete_group_id) continue;
    const g = groups.get(p.complete_group_id) ?? { conversation_id: p.conversation_id, count: 0, latestAt: p.created_at, anySent: false };
    if (p.sent_at || p.status === "sent") g.anySent = true;
    else if (!p.expired_at && (!p.status || p.status === "pending")) g.count++;
    if (p.created_at > g.latestAt) g.latestAt = p.created_at;
    groups.set(p.complete_group_id, g);
  }
  const newestGroup = new Map<string, { count: number; latestAt: string; anySent: boolean }>();
  for (const g of groups.values()) {
    const cur = newestGroup.get(g.conversation_id);
    if (!cur || g.latestAt > cur.latestAt) newestGroup.set(g.conversation_id, g);
  }
  const readyMap = new Map<string, { count: number; latestAt: string }>();
  for (const [cid, g] of newestGroup) if (!g.anySent && g.count > 0) readyMap.set(cid, { count: g.count, latestAt: g.latestAt });
  return {
    idle: idle.sort((a, b) => a.at.localeCompare(b.at)),
    empty: empty.sort((a, b) => b.at.localeCompare(a.at)),
    ready: [...readyMap.entries()].map(([conversation_id, v]) => ({ conversation_id, ...v })).sort((a, b) => b.latestAt.localeCompare(a.latestAt)),
  };
}

/** 自動で送る対象か（1段目は表示だけ・送信の判定 canAutoReply は触らない） */
export function autoBadge(autoSendEnabled: boolean | null | undefined): string {
  return autoSendEnabled ? "自動" : "";
}
