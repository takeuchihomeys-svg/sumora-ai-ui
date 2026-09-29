// app/lib/screen-watch-server.ts（サーバー専用・DB・LLM。画面側から import しない）
// 見張りの順番（①決定論 → 予算 → ②Jev（影）→ ③DeepSeek → ④裁定 → 行を残す → 動きを返す）と、結果の結び付け・週のまとめ・見張りの画面。
// 決まり（純関数）は screen-watch.ts・決め方のズレは screen-watch-expect.ts。
//
// 2026-09-29 竹内「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？ …画面開いているのも目で見ることができるのが理想」
// 決まり:
//   ・表（screen_watch_events・screen_watch_settings）は RLS 有効・ポリシーなし＝サービスロールだけ。鍵が無い時は anon に逃げない（決定論だけ返す）
//   ・見張りの失敗で検索を止めない（例外は投げない・拡張への答えは決定論が先＝LLM は応答の後の waitUntil）
//   ・表や列がまだ無い（migrate-schema を流す前）の error は飛ばす（isMissingColumnError・表が無い）
//   ・Jev・DeepSeek に渡すのは仮名化した文字だけ（帯を抜く＋名前を伏せる）・写真は拡張が帯を塗った物（mask_applied）だけ
//   ・お客様の元の言葉は申込前だけ（post-apply.loadDeepseekCutoff）
//   ・止めた時の1通は★物件出し★（pickup_group_id）だけ・サイト×2時間に1通（売上番長グループには送らない）
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  readWatchConfig, detectScreenState, actionFor, expectedCountRange, watchBudgetGate, maskWatchText, jevStateFor, parseJevLabel, JEV_QUESTIONS, JEV_ACTION,
  SCREEN_WATCH_TEXT_PROMPT, SCREEN_WATCH_IMAGE_PROMPT, SCREEN_WATCH_ARBITER_PROMPT, buildTextUser, parseWatchText, parseArbiter, stopNoticeText, shouldSendStopNotice,
  sanitizeThresholds, jstDate, jstDayStartIso, outcomeOf, placesDiffer, weeklyWatchStats, tuneCountThresholds, tuneJevGate,
  WATCH_USAGE_ACTIONS, EST_USD, DEFAULT_THRESHOLDS,
  type Checkpoint, type WatchDom, type WatchMaterial, type WatchThresholds, type Detection, type WatchAction, type CountSample, type WatchStage, type BudgetGate,
  type ModelRead, type ArbiterRead, type EventLite,
} from "@/app/lib/screen-watch";
import { buildSearchIntent, independentExpectation, decisionDrift, intentSummary, expectSummary, type SearchIntent, type SearchExpect, type DecisionDrift } from "@/app/lib/screen-watch-expect";
import { runSearchAuditChecks, type AuditInput, type AuditCheck } from "@/app/lib/search-audit-check";
import { isMissingColumnError } from "@/app/lib/extension-snapshots";
import { auditUpdateContext } from "@/app/lib/search-update-days-server";
import { hoursSince, neededDays } from "@/app/lib/search-update-days";
import { itemizeWants } from "@/app/lib/customer-wants";
import type { JevBrainMaterial } from "@/app/lib/screen-watch";
import { altUsageUsd } from "@/app/lib/llm-price";

let _admin: SupabaseClient | null = null;
function admin(): SupabaseClient | null {
  if (_admin) return _admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _admin = createClient(url, key, { auth: { persistSession: false } });
  return _admin;
}

/** 表が無い（migrate-schema を流す前） */
function isMissingTable(e: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!e) return false;
  return e.code === "42P01" || e.code === "PGRST205" || /relation .* does not exist|Could not find the table/i.test(e.message ?? "");
}
function missing(e: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return isMissingTable(e) || isMissingColumnError(e);
}

// ─── 線（screen_watch_settings の active・10分キャッシュ） ───────────────────

let _settings: { at: number; t: WatchThresholds; id: number | null } | null = null;
export async function loadThresholds(): Promise<{ t: WatchThresholds; id: number | null }> {
  if (_settings && Date.now() - _settings.at < 10 * 60_000) return _settings;
  const sb = admin();
  let t = DEFAULT_THRESHOLDS, id: number | null = null;
  if (sb) {
    const { data, error } = await sb.from("screen_watch_settings").select("id, thresholds").eq("status", "active").order("created_at", { ascending: false }).limit(1);
    if (!error && data && data[0]) { t = sanitizeThresholds((data[0] as { thresholds: unknown }).thresholds); id = (data[0] as { id: number }).id; }
  }
  _settings = { at: Date.now(), t, id };
  return _settings;
}

// ─── 今日の費用（llm_usage_logs・60秒キャッシュ＋呼んでいる最中の見積もり） ─────

let _spend: { at: number; day: string; usd: number; counts: Record<WatchStage, number> } | null = null;
let _inflightUsd = 0;
export async function todaySpend(nowMs = Date.now()): Promise<{ usd: number; counts: Record<WatchStage, number>; error: string | null }> {
  const day = jstDate(nowMs);
  if (_spend && _spend.day === day && nowMs - _spend.at < 60_000) return { usd: _spend.usd + _inflightUsd, counts: _spend.counts, error: null };
  const sb = admin();
  const counts: Record<WatchStage, number> = { jev: 0, text: 0, image: 0, arbiter: 0 };
  if (!sb) return { usd: Infinity, counts, error: "SUPABASE_SERVICE_ROLE_KEY が無い" };
  const names = Object.values(WATCH_USAGE_ACTIONS);
  const { data, error } = await sb.from("llm_usage_logs").select("created_at, model, action, input_uncached, cache_read, output_tokens")
    .in("action", names).gte("created_at", jstDayStartIso(nowMs)).limit(5000);
  // 読めない時は上限に達したとみなす（費用が分からないまま呼ばない＝安全側）
  if (error) return { usd: Infinity, counts, error: error.message };
  let usd = 0;
  for (const r of (data ?? []) as Array<{ created_at: string; model: string; action: string; input_uncached: number; cache_read: number; output_tokens: number }>) {
    usd += altUsageUsd(r, { alwaysPeak: true });
    const st = (Object.entries(WATCH_USAGE_ACTIONS).find(([, v]) => v === r.action)?.[0] ?? null) as WatchStage | null;
    if (st) counts[st]++;
  }
  _spend = { at: nowMs, day, usd, counts };
  return { usd: usd + _inflightUsd, counts, error: null };
}
function bumpInflight(stage: WatchStage, sign: 1 | -1) {
  _inflightUsd = Math.max(0, _inflightUsd + sign * EST_USD[stage]);
  if (sign === 1 && _spend) _spend.counts[stage]++;
}

// ─── 材料を集める ────────────────────────────────────────────────────────────

type AuditRow = Record<string, unknown> & {
  run_id: string; created_at: string; status: string | null; site: string | null; trigger: string | null; mode: string | null;
  property_customer_id: string | null; command_id: string | null; is_wide: boolean | null; area_mode: string | null;
  customer_snapshot: Record<string, unknown> | null; intended: Record<string, unknown> | null; filled: Record<string, unknown> | null;
  steps: unknown; result: Record<string, unknown> | null; error: string | null; error_kind: string | null;
  checks: AuditCheck[] | null; severity: string | null; cause_key: string | null;
  intent?: SearchIntent | null; expect?: SearchExpect | null; decision_drift?: DecisionDrift | null; watch?: Record<string, unknown> | null;
};

async function loadAudit(sb: SupabaseClient, runId: string | null | undefined): Promise<AuditRow | null> {
  if (!runId) return null;
  const { data, error } = await sb.from("search_audits").select("*").eq("run_id", runId).maybeSingle();
  if (error) { console.warn("[screen-watch] 点検の行を読めない:", error.message); return null; }
  return (data as AuditRow | null) ?? null;
}

const CUSTOMER_COLS = "id, customer_name, line_user_id, desired_area, commute_station, commute_minutes, rent_max, rent_min, floor_plan, floor_area_min, area_mode, adjacent_ok, preferences, other_requests, ng_points, additional_conditions, initial_cost_limit, structure_types, building_age, walk_minutes, pet";
async function loadCustomer(sb: SupabaseClient, pcid: string | null | undefined): Promise<Record<string, unknown> | null> {
  if (!pcid) return null;
  const { data, error } = await sb.from("property_customers").select(CUSTOMER_COLS).eq("id", pcid).maybeSingle();
  if (error) { console.warn("[screen-watch] お客様を読めない:", error.message); return null; }
  return (data as Record<string, unknown> | null) ?? null;
}

/** 意図と期待（行に無ければその場で作る） */
async function intentExpectFor(sb: SupabaseClient, row: AuditRow): Promise<{ intent: SearchIntent; expect: SearchExpect | null; customer: Record<string, unknown> | null }> {
  const customer = await loadCustomer(sb, row.property_customer_id);
  let intent = row.intent ?? null;
  if (!intent) {
    let payload: Record<string, unknown> | null = null;
    if (row.command_id) {
      const c = await sb.from("automation_commands").select("payload").eq("id", row.command_id).maybeSingle();
      if (!c.error) payload = ((c.data as { payload?: Record<string, unknown> } | null)?.payload) ?? null;
    }
    let history: Array<{ changed_field: string; created_at: string; source_message_id: string | null }> = [];
    if (row.property_customer_id) {
      const h = await sb.from("property_condition_history").select("changed_field, created_at, source_message_id").eq("property_customer_id", row.property_customer_id).order("created_at", { ascending: false }).limit(3);
      if (!h.error) history = (h.data ?? []) as typeof history;
    }
    intent = buildSearchIntent(row, payload as never, history);
  }
  const expect = row.expect ?? (customer ? independentExpectation(customer as never) : null);
  return { intent, expect, customer };
}

/**
 * 点検の記録が始まった時（/api/search-audits の started の後・waitUntil）: 意図と期待を1つの形で search_audits に残す。
 *   列が無い間（migrate-schema の前）は飛ばす。失敗しても何も止めない
 */
export async function writeIntentExpect(runId: string): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  try {
    const sb = admin();
    if (!sb) return { ok: false, skipped: "no_service_role" };
    const row = await loadAudit(sb, runId);
    if (!row) return { ok: false, skipped: "no_row" };
    if (!row.intended) return { ok: true, skipped: "no_intended_yet" }; // 入れようとした値が届いてから（started が2回来る）
    const { intent, expect } = await intentExpectFor(sb, { ...row, intent: null, expect: null });
    const { error } = await sb.from("search_audits").update({ intent, expect }).eq("run_id", runId);
    if (error) return missing(error) ? { ok: true, skipped: "no_column" } : { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 過去の件数（同じお客様×サイト×ピンポイント／広げて）。新しい順 */
async function countHistory(sb: SupabaseClient, pcid: string | null, site: string | null, isWide: boolean | null, beforeIso: string): Promise<CountSample[]> {
  if (!pcid || !site) return [];
  const out: Array<CountSample & { at: string }> = [];
  const ev = await sb.from("screen_watch_events").select("created_at, material").eq("property_customer_id", pcid).eq("site", site).eq("final_label", "normal")
    .eq("checkpoint", "results").lt("created_at", beforeIso).order("created_at", { ascending: false }).limit(10);
  if (!ev.error) for (const r of (ev.data ?? []) as Array<{ created_at: string; material: Record<string, unknown> | null }>) {
    const m = r.material ?? {};
    if (typeof m.count === "number" && (isWide == null || m.is_wide === isWide)) out.push({ count: m.count, kind: "screen", at: r.created_at });
  }
  let q = sb.from("search_audits").select("created_at, result, severity, cause_key").eq("property_customer_id", pcid).eq("site", site).eq("status", "finished")
    .lt("created_at", beforeIso).order("created_at", { ascending: false }).limit(10);
  if (isWide != null) q = q.eq("is_wide", isWide);
  const au = await q;
  if (!au.error) for (const r of (au.data ?? []) as Array<{ created_at: string; result: Record<string, unknown> | null; severity: string | null; cause_key: string | null }>) {
    const okRun = r.severity !== "bad" || String(r.cause_key ?? "").startsWith("update_days");
    const n = r.result?.read_rows ?? r.result?.property_count;
    if (okRun && typeof n === "number" && !r.result?.batch_timed_out) out.push({ count: n, kind: "rows", at: r.created_at });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1)).map(({ count, kind }) => ({ count, kind }));
}

// ─── 見張りの1回 ─────────────────────────────────────────────────────────────

export type CheckpointInput = {
  checkpoint: Checkpoint;
  runId?: string | null;
  commandId?: string | null;
  installId?: string | null;
  customerId?: string | null;
  site?: string | null;
  dom?: WatchDom | null;
  domError?: string | null;
  filled?: Record<string, unknown> | null;
  error?: string | null;
  stallKind?: string | null;
  idleMin?: number | null;
  waitingFor?: string | null;
  /** C4: extension_snapshots の行（写真の URL・帯を塗ったか） */
  snapshotId?: number | null;
};

export type CheckpointDecision = {
  label: string;
  action: WatchAction["kind"];
  reason: string;
  hard: boolean;
  stop_site: { site: string; label: string; reason: string } | null;
};

function siteKey(s: string | null | undefined): string | null {
  const v = String(s ?? "").toLowerCase();
  if (v === "realpro" || v === "realnetpro" || v === "リアプロ") return "realpro";
  if (v === "itandi") return "itandi";
  if (v === "reins" || v === "レインズ") return "reins";
  return v || null;
}

/** 更新日の材料（その回の入れようとした日数・前回の検索から空いた時間） */
function updateMaterial(row: AuditRow | null, lastSearchAt: string | null): WatchMaterial["update"] {
  if (!row) return null;
  const v = row.intended?.rp_update_days;
  const days = typeof v === "number" && v > 0 ? v : typeof v === "string" && Number(v) > 0 ? Number(v) : null;
  const start = Date.parse(row.created_at);
  const gap = hoursSince(lastSearchAt, Number.isFinite(start) ? start : Date.now());
  return { days, gap_hours: gap == null ? null : Math.round(gap * 10) / 10, need_days: neededDays(gap), last_search_at: lastSearchAt };
}

/**
 * Jev に渡すブレインの材料（名前は入れない・自由文は伏せる）。見張りは意図を渡してよい（memory feedback_jev_brain_materials）
 *   2026-09-29 竹内「顧客名はアカウント名やから…質が落ちる可能性あるなら防がなくて大丈夫だが、質が落ちないなら防ぐ」:
 *   画面の様子（止まり・ログイン・条件の入り方）の判断に名前は使わない＝伏せても質は落ちない → 今まで通り伏せる
 */
function jevBrainMaterial(customer: Record<string, unknown> | null, row: AuditRow | null, intent: SearchIntent | null, update: WatchMaterial["update"], mk: (s: unknown) => string): JevBrainMaterial | null {
  if (!customer && !row) return null;
  const c = customer ?? {};
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const snapOverride = !!(row?.customer_snapshot && (row.customer_snapshot as Record<string, unknown>)._search_override);
  let wants: string[] = [];
  try { wants = customer ? itemizeWants(customer as never).map((w) => `${w.kind === "その他" ? "" : `${w.kind}:`}${w.label}`) : []; } catch { wants = []; }
  return {
    conditions: customer ? {
      desired_area: mk(c.desired_area).slice(0, 120) || null, area_mode: c.area_mode ?? null, rent_max: num(c.rent_max), rent_min: num(c.rent_min),
      floor_plan: c.floor_plan ?? null, floor_area_min: num(c.floor_area_min), walk_minutes: num(c.walk_minutes), building_age: num(c.building_age), pet: c.pet ?? null,
    } : null,
    wants: wants.map((w) => mk(w)),
    commute: c.commute_station ? `${mk(c.commute_station)}まで${num(c.commute_minutes) ?? "?"}分` : null,
    scope: snapOverride || intent?.override ? "temporary" : customer ? "permanent" : null,
    intent: intent ? intentSummary(intent) : null,
    update_days: update ? { days: update.days, gap_hours: update.gap_hours, need_days: update.need_days } : null,
  };
}

/** 入れようとした場所の数（駅＋区・市＋レインズの駅）。分からなければ null */
function areaSizeOf(i: Record<string, unknown> | null): number | null {
  if (!i) return null;
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const n = len(i.station_names) + len(i.city_codes) + len(i.ward_names) + len(i.reins_station_pairs);
  return n > 0 ? n : null;
}

const toAuditInput = (row: AuditRow, patch: Partial<AuditRow>, extra: Pick<AuditInput, "command_payload" | "last_search_at"> = {}): AuditInput => {
  const r = { ...row, ...patch };
  return {
    ...extra, customer_id: r.property_customer_id ?? null,
    site: r.site, status: r.status, trigger: r.trigger, is_wide: r.is_wide, area_mode: r.area_mode,
    customer_snapshot: r.customer_snapshot as never, intended: r.intended as never, filled: r.filled as never, steps: r.steps as never,
    result: r.result as never, error: r.error, error_kind: r.error_kind, created_at: r.created_at,
  };
};

/**
 * 要所1つを見る。決定論の答え（拡張に返す）と、その後の LLM・行の記録（応答の後に waitUntil で待つ）を分けて返す。
 */
export async function runCheckpoint(input: CheckpointInput, nowMs = Date.now()): Promise<{ decision: CheckpointDecision; followUp: Promise<void> }> {
  const cfg = readWatchConfig();
  const none: CheckpointDecision = { label: "normal", action: "none", reason: "見張りは止めてある（SCREEN_WATCH=off）", hard: false, stop_site: null };
  if (!cfg.enabled) return { decision: none, followUp: Promise.resolve() };
  try {
    const sb = admin();
    const row = sb ? await loadAudit(sb, input.runId) : null;
    let dom: WatchDom | null = input.dom ?? null;
    let domError = input.domError ?? null;
    let snapTab: Record<string, unknown> | null = null;
    let snapBand: string | null = null;
    // C4: 写真の行（止まりの写真）からサイトのタブの文字と写真を読む
    if (input.checkpoint === "stall" && sb && input.snapshotId != null) {
      const s = await sb.from("extension_snapshots").select("tabs, stall, band_text, audit_run_id, property_customer_id").eq("id", input.snapshotId).maybeSingle();
      if (!s.error && s.data) {
        const sd = s.data as { tabs: Array<Record<string, unknown>> | null; stall: Record<string, unknown> | null; band_text: string | null };
        const want = siteKey((sd.stall?.watch as Record<string, unknown> | undefined)?.site as string | undefined) ?? siteKey(input.site);
        snapTab = (sd.tabs ?? []).find((t) => siteKey(t.site as string) === want) ?? (sd.tabs ?? [])[0] ?? null;
        dom = (snapTab?.dom as WatchDom | undefined) ?? null;
        domError = (snapTab?.dom_error as string | undefined) ?? null;
        snapBand = sd.band_text;
        if (!input.site && want) input.site = want;
      }
    }
    const site = siteKey(input.site ?? row?.site);
    const pcid = input.customerId ?? row?.property_customer_id ?? null;
    const { t } = await loadThresholds();

    // 札（決定論の点検）: C1 は届いた読み戻しで点検をその場で当てる・C3 は行の札・C2／C4 は画面の文字だけ
    let checks: AuditCheck[] = [];
    // 2026-09-29 v2.5.41 更新日: 命令の payload（計画）と前回の検索（最後に終わった回）を点検に渡す（C1＝入ったか・空いた分を覆えたか）
    const updCtx = sb && row && (input.checkpoint === "filled" || input.checkpoint === "results") ? await auditUpdateContext(sb, row) : { command_payload: null, last_search_at: null };
    if (row && input.checkpoint === "filled" && input.filled) checks = runSearchAuditChecks(toAuditInput(row, { filled: input.filled, status: "started", result: null, error: null, error_kind: null }, updCtx), nowMs).checks;
    if (row && input.checkpoint === "done") checks = row.checks ?? [];
    // 決め方のズレ（C1 だけ・同じズレを C3 で2回言わない）
    let intent: SearchIntent | null = null, expect: SearchExpect | null = null, decision: DecisionDrift | null = null, customer: Record<string, unknown> | null = null;
    if (sb && row && input.checkpoint === "filled") {
      const ie = await intentExpectFor(sb, row);
      intent = ie.intent; expect = ie.expect; customer = ie.customer;
      decision = decisionDrift(intent, expect, input.filled as never);
    }
    const isWide = row?.is_wide ?? null;
    const range = sb && (input.checkpoint === "results" || input.checkpoint === "done")
      ? expectedCountRange(await countHistory(sb, pcid, site, isWide, row?.created_at ?? new Date(nowMs).toISOString()), t) : null;
    const material: WatchMaterial = {
      checkpoint: input.checkpoint, site, dom, dom_error: domError, checks,
      error: input.error ?? (input.checkpoint === "done" ? row?.error ?? null : null),
      error_kind: input.checkpoint === "done" ? row?.error_kind ?? null : null,
      stall_kind: input.stallKind ?? null, idle_min: input.idleMin ?? null, waiting_for: input.waitingFor ?? null,
      range, read_rows: input.checkpoint === "done" ? (row?.result?.read_rows as number | undefined) ?? null : null,
      decision: decision ? { severity: decision.severity, items: decision.items } : null, is_wide: isWide,
      area_size: areaSizeOf(row?.intended ?? null),
      update: updateMaterial(row, updCtx.last_search_at),
    };
    const det = detectScreenState(material, t);
    const action = actionFor(det.label, { hard: det.hard });
    const out: CheckpointDecision = {
      label: det.label, action: action.kind, reason: det.reason, hard: det.hard,
      stop_site: action.stopSite && site ? { site, label: det.label, reason: det.reason } : null,
    };
    const followUp = afterDecision({ sb, cfg, input, row, site, pcid, det, action, material, intent, expect, decision, customer, snapTab, snapBand, thresholdsId: _settings?.id ?? null, nowMs })
      .catch((e) => console.warn("[screen-watch] 後の段に失敗（検索は止めない）:", e instanceof Error ? e.message : String(e)));
    return { decision: out, followUp };
  } catch (e) {
    console.warn("[screen-watch] 見張りに失敗（検索は止めない）:", e instanceof Error ? e.message : String(e));
    return { decision: { ...none, reason: "見張りの失敗（検索は続ける）" }, followUp: Promise.resolve() };
  }
}

type AfterCtx = {
  sb: SupabaseClient | null; cfg: ReturnType<typeof readWatchConfig>; input: CheckpointInput; row: AuditRow | null; site: string | null; pcid: string | null;
  det: Detection; action: WatchAction; material: WatchMaterial; intent: SearchIntent | null; expect: SearchExpect | null; decision: DecisionDrift | null;
  customer: Record<string, unknown> | null; snapTab: Record<string, unknown> | null; snapBand: string | null; thresholdsId: number | null; nowMs: number;
};

async function recordUsage(action: string, model: string, attempts: Array<{ res: { usage: { input: number; output: number; cacheHit: number }; model: string } | null; ok: boolean; ms: number; retry: boolean }>, sysHead: string, maxTokens: number): Promise<number> {
  let usd = 0;
  const now = new Date().toISOString();
  const { recordAltUsage } = await import("@/app/lib/llm-usage-recorder");
  for (const a of attempts) {
    const u = a.res?.usage;
    const row = { model: a.res?.model ?? model, input_uncached: Math.max(0, (u?.input ?? 0) - (u?.cacheHit ?? 0)), cache_read: u?.cacheHit ?? 0, output_tokens: u?.output ?? 0, created_at: now };
    usd += altUsageUsd(row);
    recordAltUsage({
      model: row.model, action, conversationId: null,
      usage: { input_tokens: row.input_uncached, output_tokens: row.output_tokens, cache_read_input_tokens: row.cache_read },
      status: a.res ? 200 : 0, errorType: a.ok ? null : a.res ? "empty_or_unparsable" : "no_response",
      durationMs: a.ms, sysHead: `${sysHead}${a.retry ? "・読み直し" : ""}`, sysKeyFull: null, maxTokens,
    });
  }
  return usd;
}

async function afterDecision(c: AfterCtx): Promise<void> {
  const { sb, cfg, input, row, site, pcid, det, action, material, nowMs } = c;
  const runId = input.runId ?? row?.run_id ?? null;
  const names = [c.customer?.customer_name as string | undefined, (row?.customer_snapshot?.customer_name as string | undefined)].filter(Boolean) as string[];
  // 2026-09-29 検証: customer_snapshot には名前が無く、C1 以外（results・stall・done）は c.customer も無い＝names が空のまま
  //   拡張の失敗の文（describeStall「見張りの時間切れ（20分）: 隼斗さん・リアプロ・…」）が DeepSeek に届いていた。名前を引いてから伏せる
  if (!names.length && sb && pcid) {
    try {
      const q = await sb.from("property_customers").select("customer_name").eq("id", pcid).maybeSingle();
      const nm = (q.data as { customer_name?: string | null } | null)?.customer_name;
      if (nm) names.push(nm);
    } catch { /* 引けなくても下の「〇〇さん」の伏せで落とす */ }
  }
  const dom = material.dom ?? {};
  const band = dom.band_text ?? c.snapBand ?? null;
  const mk = (s: unknown) => maskWatchText(String(s ?? ""), { bandText: band, names, seed: pcid ?? "screen-watch" });
  const masked = { count: mk(dom.count_text), page: mk(dom.page_text), alert: mk(dom.alert_text), modal: mk(dom.modal_text), title: mk(dom.title), head: mk(dom.text_head) };
  // 拡張の失敗の文・待っていた物は「〇〇さん・リアプロ」の形で名前を持つ（名前が引けない時も「…さん」の前を伏せる）
  const mkWho = (s: string | null | undefined) => (s ? mk(s).replace(/[^\s:：・、,，（(「]{1,16}さん(?=[・、,，\s)）」]|$)/g, "〇〇さん") : s ?? null);
  const llmMaterial: WatchMaterial = { ...material, error: mkWho(material.error), waiting_for: mkWho(material.waiting_for) };

  // 予算の関所
  const keys = { jev: !!(process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? "").trim() && cfg.jev !== "off", deepseek: !!(process.env.DEEPSEEK_API_KEY ?? "").trim() };
  let gate: BudgetGate = { state: "no_key", allow: { jev: false, text: false, image: false, arbiter: false }, reason: "no db" };
  let evCols = true;
  if (sb) {
    const spend = await todaySpend(nowMs);
    const perRun = { jev: 0, text: 0, image: 0 };
    let arbiterDoneToday = false;
    {
      // 回ごとの回数（run_id が無い時は表があるかだけ見る）
      const pr = runId
        ? await sb.from("screen_watch_events").select("jev_label, ds_label, ds_image").eq("run_id", runId).limit(50)
        : await sb.from("screen_watch_events").select("jev_label, ds_label, ds_image").limit(0);
      if (pr.error) evCols = false; // 表が無い・読めない → 回数を数えられないので LLM は呼ばない（行も残さない）
      if (pr.error && !missing(pr.error)) console.warn("[screen-watch] 見張りの表を読めない:", pr.error.message);
      for (const r of (pr.data ?? []) as Array<{ jev_label: string | null; ds_label: string | null; ds_image: boolean | null }>) {
        if (r.jev_label) perRun.jev++;
        if (r.ds_label && !r.ds_image) perRun.text++;
        if (r.ds_image) perRun.image++;
      }
    }
    if (pcid && site && evCols) {
      const ar = await sb.from("screen_watch_events").select("id").eq("property_customer_id", pcid).eq("site", site).eq("jst_date", jstDate(nowMs)).not("arbiter", "is", null).limit(1);
      arbiterDoneToday = !!(ar.data && ar.data.length);
    }
    // 表が無い間は回数を数えられない → LLM は呼ばない（上限を守れないため）
    gate = evCols ? watchBudgetGate({ spentUsd: spend.usd, capUsd: cfg.dailyUsd, counts: spend.counts, perRun, arbiterDoneToday, keys }) : { state: "no_key", allow: { jev: false, text: false, image: false, arbiter: false }, reason: "screen_watch_events が無い" };
  }
  let cost = 0;
  const causeKey = (material.checks ?? []).find((x) => x.severity === "bad" && x.code !== "UPDATE_DAYS")?.cause_key ?? (det.rules[0] ? `${site ?? "-"}:${det.rules[0]}` : null);

  // ② Jev（影）
  let jev: { label: string; prob: number | null; ms: number } | null = null;
  const wantJev = material.checkpoint === "results" || material.checkpoint === "stall" || det.label !== "normal";
  if (wantJev && gate.allow.jev) {
    bumpInflight("jev", 1);
    try {
      const { jevSystemOne } = await import("@/app/lib/jev-client");
      // ブレインの材料（登録の条件・要望・通勤・今回だけか・意図・前回からの時間）。C1 以外はここでお客様を読む（Jev を呼ぶ時だけ）
      const cust = c.customer ?? (sb && pcid ? await loadCustomer(sb, pcid) : null);
      const brain = jevBrainMaterial(cust, row, c.intent ?? row?.intent ?? null, material.update ?? null, mk);
      const r = await jevSystemOne({ state: jevStateFor(llmMaterial, masked, det, brain), questions: JEV_QUESTIONS as never, action: JEV_ACTION, timeoutMs: 4_000 });
      const p = r ? parseJevLabel(r.answers as never) : null;
      if (r) { jev = { label: p?.label ?? "unparsed", prob: p?.prob ?? null, ms: r.ms }; cost += (r.usage.input_tokens * 0.042) / 1e6; }
    } finally { bumpInflight("jev", -1); }
  }

  // ③ DeepSeek の文字（異常の疑い・硬くない・C3 は既存の見立て runDiagnosis に任せる）
  let ds: ModelRead | null = null, dsImage = false, dsNote: string | null = null;
  const gateSaysGo = cfg.jev !== "gate" || !jev || jev.label !== "normal";
  if (det.label !== "normal" && !det.hard && material.checkpoint !== "done" && gateSaysGo) {
    // 同じ原因（点検の原因の鍵・無ければ当たった規則）の見立てが7日以内にあれば使い回す（既存の runDiagnosis と同じ）
    if (sb && evCols && causeKey) {
      const since = new Date(nowMs - 7 * 86400_000).toISOString();
      const prev = await sb.from("screen_watch_events").select("ds_label, ds_note").eq("material->>cause_key", causeKey).not("ds_note", "is", null).gte("created_at", since).order("created_at", { ascending: false }).limit(1);
      const p = (prev.data ?? [])[0] as { ds_label: string | null; ds_note: string | null } | undefined;
      if (p?.ds_note) { ds = { label: (p.ds_label ?? "unknown") as ModelRead["label"], reason_ja: p.ds_note, confidence: null }; dsNote = `（使い回し）${p.ds_note}`; }
    }
    if (!ds && gate.allow.text) {
      bumpInflight("text", 1);
      try {
        const { callDeepSeekRead } = await import("@/app/lib/vision-alt-provider");
        const { DEEPSEEK_FLASH_MODEL } = await import("@/app/lib/llm-alt-provider");
        const r = await callDeepSeekRead(SCREEN_WATCH_TEXT_PROMPT, buildTextUser(llmMaterial, masked, det), { maxTokens: 300, timeoutMs: 20_000, model: DEEPSEEK_FLASH_MODEL }, parseWatchText, { retryIf: (e) => e < 15_000 });
        cost += await recordUsage(WATCH_USAGE_ACTIONS.text, DEEPSEEK_FLASH_MODEL, r.attempts as never, "【見張り・画面の文字】", 300);
        ds = r.value; dsNote = r.value?.reason_ja ?? null;
      } finally { bumpInflight("text", -1); }
    }
  }
  // ③' 写真（①②で決められず・ページの文字が取れていない止まりの時だけ・帯を塗った写真だけ）
  const noText = !!material.dom_error || (!dom.count_text && !dom.alert_text && !dom.modal_text);
  const undecided = (det.label === "stuck" || det.label === "normal") && (!ds || ds.label === "unknown");
  const imgUrl = typeof c.snapTab?.image_url === "string" ? c.snapTab.image_url as string : null;
  if (material.checkpoint === "stall" && undecided && noText && cfg.image && gate.allow.image && imgUrl && c.snapTab?.mask_applied === true) {
    bumpInflight("image", 1);
    try {
      const { callDeepSeekRead } = await import("@/app/lib/vision-alt-provider");
      const { DEEPSEEK_FLASH_MODEL } = await import("@/app/lib/llm-alt-provider");
      const content = [{ type: "text", text: `段: ${material.checkpoint}・サイト: ${site ?? "?"}・動きの無い分: ${material.idle_min ?? "-"}` }, { type: "image_url", image_url: { url: imgUrl } }];
      const r = await callDeepSeekRead(SCREEN_WATCH_IMAGE_PROMPT, content, { maxTokens: 300, timeoutMs: 30_000, model: DEEPSEEK_FLASH_MODEL }, parseWatchText, { retryIf: () => false });
      cost += await recordUsage(WATCH_USAGE_ACTIONS.image, DEEPSEEK_FLASH_MODEL, r.attempts as never, "【見張り・画面の写真】", 300);
      if (r.value) { ds = r.value; dsImage = true; dsNote = r.value.reason_ja; }
    } finally { bumpInflight("image", -1); }
  }

  // ④ 裁定（決め方のズレの時だけ・お客様×サイト×日に1回・提案だけ）
  let arbiter: (ArbiterRead & { intent: string; expect: string }) | null = null;
  if (c.decision && c.decision.severity !== "ok" && gate.allow.arbiter && sb && pcid) {
    bumpInflight("arbiter", 1);
    try {
      const words = await customerWords(sb, pcid, names);
      const user = [
        `サイト: ${site}・${c.intent?.is_wide ? "広げて" : "ピンポイント"}・${c.intent?.source ?? "-"}`,
        `お客様の元の言葉（申込前・直近3件）: ${words.length ? words.map((w) => `「${w}」`).join(" ") : "無し"}`,
        `登録の条件: 希望エリア「${mk(c.customer?.desired_area)}」・通勤 ${c.customer?.commute_station ?? "-"}:${c.customer?.commute_minutes ?? "-"}・家賃上限 ${c.customer?.rent_max ?? "-"}・間取り ${c.customer?.floor_plan ?? "-"}`,
        `brain（意図）: ${intentSummary(c.intent)}`,
        `table（期待）: ${expectSummary(c.expect)}`,
        `screen（画面）: 駅 ${c.decision.screen.stations ?? "?"}件・件数 ${dom.count_text ? mk(dom.count_text) : "-"}`,
        `食い違い: ${c.decision.items.map((x) => `${x.severity} ${x.title}`).join("／")}`,
      ].join("\n");
      const { callDeepSeekRead } = await import("@/app/lib/vision-alt-provider");
      const { DEEPSEEK_FLASH_MODEL } = await import("@/app/lib/llm-alt-provider");
      const r = await callDeepSeekRead(SCREEN_WATCH_ARBITER_PROMPT, user, { maxTokens: 300, timeoutMs: 20_000, model: DEEPSEEK_FLASH_MODEL }, parseArbiter, { retryIf: (e) => e < 15_000 });
      cost += await recordUsage(WATCH_USAGE_ACTIONS.arbiter, DEEPSEEK_FLASH_MODEL, r.attempts as never, "【見張り・裁定】", 300);
      if (r.value) arbiter = { ...r.value, intent: intentSummary(c.intent), expect: expectSummary(c.expect) };
    } finally { bumpInflight("arbiter", -1); }
  }

  // 最後のラベル: 決定論が正。止まり・問題なしの止まりで DeepSeek が別の異常を読んだ時だけ置き換える（その時も止めない＝硬くない）
  const finalLabel = (det.label === "stuck" || (det.label === "normal" && material.checkpoint === "stall")) && ds && ds.label !== "unknown" && ds.label !== "normal" ? ds.label : det.label;

  // 止めた時の1通（★物件出し★だけ・サイト×2時間に1通）
  let notified: string | null = null;
  if (action.stopSite && site) notified = await sendStopNotice(sb, det, site, input.commandId ?? row?.command_id ?? null, evCols, nowMs);

  // search_audits に見張りの印（自動の広げてを止める・⚠ の1行）
  if (sb && runId && (finalLabel !== "normal" || c.decision || det.update_notice)) {
    const prevWatch = row?.watch ?? null;
    // 2026-09-29 v2.5.41 更新日の1行（ラベルは変えない）は前の印に重ねて残す（★物件出し★のまとめに1行）
    const updNotice = det.update_notice ?? ((prevWatch as { update_notice?: string | null } | null)?.update_notice ?? null);
    const watch = { label: finalLabel, action: action.kind, block_widen: action.blockWiden, notice: det.notice, update_notice: updNotice, checkpoint: material.checkpoint, at: new Date(nowMs).toISOString() };
    const keepBlock = !!(prevWatch && (prevWatch as { block_widen?: boolean }).block_widen);
    const patch: Record<string, unknown> = {};
    if (finalLabel !== "normal" || !prevWatch) patch.watch = keepBlock ? { ...watch, block_widen: true, notice: det.notice ?? (prevWatch as { notice?: string }).notice ?? null } : watch;
    else if (det.update_notice) patch.watch = { ...(prevWatch as Record<string, unknown>), update_notice: det.update_notice };
    if (c.decision) patch.decision_drift = c.decision;
    if (c.intent && !row?.intent) patch.intent = c.intent;
    if (c.expect && !row?.expect) patch.expect = c.expect;
    const { error } = await sb.from("search_audits").update(patch).eq("run_id", runId);
    if (error && !missing(error)) console.warn("[screen-watch] 点検の行に印を書けない:", error.message);
  }

  // 1行残す（材料は仮名化済みの小さな物だけ・名前は入れない）
  if (sb && evCols) {
    const ev = {
      jst_date: jstDate(nowMs), run_id: runId, command_id: input.commandId ?? row?.command_id ?? null, install_id: input.installId ?? null,
      property_customer_id: pcid, site, checkpoint: material.checkpoint,
      det_label: det.label, det_rules: det.rules.slice(0, 12), det_hard: det.hard,
      jev_label: jev?.label ?? null, jev_prob: jev?.prob ?? null, jev_ms: jev?.ms ?? null, jev_mode: jev ? cfg.jev : null,
      ds_label: ds?.label ?? null, ds_image: dsImage, ds_note: dsNote ? dsNote.slice(0, 300) : null, arbiter,
      final_label: finalLabel, action: action.kind, action_reason: `${action.reason}${notified ? `・${notified}` : ""}`.slice(0, 300),
      budget_state: gate.state === "no_key" && sb ? "no_key" : gate.state, cost_usd: +cost.toFixed(6),
      material: {
        count: typeof dom.count_number === "number" ? dom.count_number : null, count_text: masked.count || null, page: masked.page || null,
        alert: masked.alert || null, modal: masked.modal || null, dom_error: material.dom_error ?? null, is_wide: material.is_wide ?? null,
        range_median: material.range?.median ?? null, range_low: material.range?.low ?? null, read_rows: material.read_rows ?? null,
        checks: (material.checks ?? []).filter((x) => x.severity !== "ok" && x.code !== "UPDATE_DAYS").slice(0, 6).map((x) => x.title ?? x.code),
        decision_missing: c.decision?.missing ?? [], decision_extra: c.decision?.extra ?? [],
        intent_places: c.intent ? { stations: c.intent.stations.slice(0, 60), wards: c.intent.wards } : null,
        notice: det.notice, update: material.update ?? null, update_items: det.update_items.slice(0, 4), update_notice: det.update_notice,
        waiting_for: material.waiting_for ?? null, idle_min: material.idle_min ?? null, thresholds_id: c.thresholdsId,
        snapshot_id: input.snapshotId ?? null, reason: det.reason.slice(0, 200), cause_key: causeKey,
      },
    };
    const { error } = await sb.from("screen_watch_events").insert(ev);
    if (error && !missing(error)) console.warn("[screen-watch] 行を残せない:", error.message);
  }
  console.log(JSON.stringify({ tag: "screen-watch", cp: material.checkpoint, site, run: runId, det: det.label, hard: det.hard, final: finalLabel, action: action.kind, jev: jev?.label ?? null, ds: ds?.label ?? null, arbiter: arbiter?.right ?? null, budget: gate.state, usd: +cost.toFixed(6), notified }));
}

/** お客様の元の言葉（条件の履歴の source_message_id から直近3件・申込前だけ・仮名化） */
async function customerWords(sb: SupabaseClient, pcid: string, names: string[]): Promise<string[]> {
  const h = await sb.from("property_condition_history").select("source_message_id, created_at").eq("property_customer_id", pcid).not("source_message_id", "is", null).order("created_at", { ascending: false }).limit(3);
  const ids = ((h.data ?? []) as Array<{ source_message_id: string }>).map((x) => x.source_message_id).filter(Boolean);
  if (!ids.length) return [];
  const m = await sb.from("messages").select("id, text, conversation_id, created_at").in("id", ids).limit(3);
  if (m.error) return [];
  const { loadDeepseekCutoff, isAfterCutoff } = await import("@/app/lib/post-apply");
  const out: string[] = [];
  for (const r of (m.data ?? []) as Array<{ text: string | null; conversation_id: string | null; created_at: string }>) {
    const cut = await loadDeepseekCutoff(sb as never, r.conversation_id);
    if (!isAfterCutoff(r.created_at, cut)) continue; // 申込以降・線が引けない会話は渡さない
    out.push(maskWatchText(String(r.text ?? "").slice(0, 200), { names, seed: r.conversation_id ?? pcid }));
  }
  return out;
}

const _lastStop = new Map<string, number>();
async function sendStopNotice(sb: SupabaseClient | null, det: Detection, site: string, commandId: string | null, evCols: boolean, nowMs: number): Promise<string | null> {
  const cfg = readWatchConfig();
  // サイト×2時間に1通（表があれば表で・無い間はこの PC のメモリで）
  let lastMs: number | null = _lastStop.get(site) ?? null;
  if (sb && evCols) {
    const q = await sb.from("screen_watch_events").select("created_at").eq("site", site).eq("action", "stop_site").like("action_reason", "%1通送った%").order("created_at", { ascending: false }).limit(1);
    const r = (q.data ?? [])[0] as { created_at: string } | undefined;
    if (r) lastMs = Math.max(lastMs ?? 0, Date.parse(r.created_at));
  }
  if (!shouldSendStopNotice(lastMs, nowMs)) return "知らせは2時間以内に送り済み";
  _lastStop.set(site, nowMs);
  let remaining: number | null = null;
  if (sb && commandId) {
    const c = await sb.from("automation_commands").select("total_customers, processed_customers").eq("id", commandId).maybeSingle();
    const d = c.data as { total_customers: number | null; processed_customers: number | null } | null;
    if (d && typeof d.total_customers === "number") remaining = Math.max(0, d.total_customers - (d.processed_customers ?? 0) - 1);
  }
  if (!cfg.notifyGroup) return "★物件出し★への知らせは止めてある（AIXツールの見張りの画面だけ）";
  const { pushPickupGroupNotice } = await import("@/app/lib/pickup-group-announce-server");
  const r = await pushPickupGroupNotice(stopNoticeText(det.label, site, remaining));
  return r.sent ? "★物件出し★に1通送った" : `知らせを送れない: ${r.error}`;
}

// ─── 自動の広げて・★物件出し★の1行（他の所から呼ぶ） ─────────────────────────

/** そのお客様×サイトの直近の回のうち「自動の広げてを止める」印の付いた回の run_id（読めない時は []＝今まで通り） */
export async function watchBlockedRunIds(pcid: string, site: string, sinceIso: string): Promise<string[]> {
  try {
    const sb = admin();
    if (!sb) return [];
    const { data, error } = await sb.from("search_audits").select("run_id, watch").eq("property_customer_id", pcid).eq("site", siteKey(site) ?? site).gte("created_at", sinceIso).limit(40);
    if (error) return [];
    return ((data ?? []) as Array<{ run_id: string; watch: { block_widen?: boolean } | null }>).filter((r) => r.watch?.block_widen === true).map((r) => r.run_id);
  } catch { return []; }
}

/** ★物件出し★のまとめの知らせに足す1行（この回の検索の注意）。読めない時は [] */
export async function watchNoticeLines(pcid: string, sinceIso: string | null): Promise<string[]> {
  try {
    const sb = admin();
    if (!sb) return [];
    const since = sinceIso ? new Date(Date.parse(sinceIso) - 40 * 60_000).toISOString() : new Date(Date.now() - 3 * 3600_000).toISOString();
    const { data, error } = await sb.from("search_audits").select("watch, result").eq("property_customer_id", pcid).gte("created_at", since).limit(20);
    if (error) return [];
    const out: string[] = [];
    let skipped = 0;
    for (const r of (data ?? []) as Array<{ watch: { notice?: string | null; update_notice?: string | null } | null; result: { sent_skipped?: number | null } | null }>) {
      for (const n of [r.watch?.notice, r.watch?.update_notice]) if (n && !out.includes(n)) out.push(n);
      const k = r.result?.sent_skipped;
      if (typeof k === "number" && k > 0) skipped += k;
    }
    // 2026-09-29 v2.5.41 竹内「一度送ったことがある物件はダウンロードもしないように」: 飛ばした数を1行
    const lines = out.slice(0, 3);
    if (skipped > 0) lines.push(`（送付済みの部屋 ${skipped}件は飛ばしました・資料もダウンロードしていません）`);
    return lines;
  } catch { return []; }
}

// ─── 結果の結び付け（15分ごと・search-audit-sweep） ─────────────────────────

export async function fillOutcomes(nowMs = Date.now(), limit = 200): Promise<{ ok: boolean; filled: number; skipped?: string; error?: string }> {
  const sb = admin();
  if (!sb) return { ok: true, filled: 0, skipped: "no_service_role" };
  const until = new Date(nowMs - 24 * 3600_000).toISOString();
  const since = new Date(nowMs - 5 * 86400_000).toISOString();
  const { data, error } = await sb.from("screen_watch_events").select("id, created_at, run_id, property_customer_id, site, final_label, material").is("outcome", null).lte("created_at", until).gte("created_at", since).order("created_at", { ascending: true }).limit(limit);
  if (error) return missing(error) ? { ok: true, filled: 0, skipped: "no_table" } : { ok: false, filled: 0, error: error.message };
  let n = 0;
  for (const e of (data ?? []) as Array<{ id: number; created_at: string; run_id: string | null; property_customer_id: string | null; site: string | null; final_label: string; material: Record<string, unknown> | null }>) {
    const at = Date.parse(e.created_at);
    const end = new Date(at + 24 * 3600_000).toISOString();
    let sev: string | null = null, cause: string | null = null, kind: string | null = null;
    if (e.run_id) {
      const a = await sb.from("search_audits").select("severity, cause_key, error_kind").eq("run_id", e.run_id).maybeSingle();
      const d = a.data as { severity: string | null; cause_key: string | null; error_kind: string | null } | null;
      if (d) { sev = d.severity; cause = d.cause_key; kind = d.error_kind; }
    }
    let staffFixed = false, conditionChanged = false;
    if (e.property_customer_id) {
      const places = (e.material?.intent_places ?? null) as { stations?: string[]; wards?: string[] } | null;
      if (places) {
        const s = await sb.from("search_audits").select("intended").eq("property_customer_id", e.property_customer_id).eq("site", e.site ?? "").eq("trigger", "single").gt("created_at", e.created_at).lte("created_at", end).limit(5);
        for (const r of (s.data ?? []) as Array<{ intended: Record<string, unknown> | null }>) {
          const st = Array.isArray(r.intended?.station_names) ? (r.intended!.station_names as string[]) : [];
          const cc = Array.isArray(r.intended?.city_codes) ? (r.intended!.city_codes as string[]).map(String) : [];
          if ((st.length && placesDiffer(st, places.stations ?? [])) || (cc.length && !st.length && (places.wards ?? []).length && cc.length !== (places.wards ?? []).length)) staffFixed = true;
        }
      }
      const h = await sb.from("property_condition_history").select("id").eq("property_customer_id", e.property_customer_id).gt("created_at", e.created_at).lte("created_at", end).limit(1);
      conditionChanged = !!(h.data && h.data.length);
    }
    const o = outcomeOf(e.final_label, { severity: sev, cause_key: cause, error_kind: kind, staffFixed, conditionChanged, ageMs: nowMs - at });
    if (!o) continue;
    const u = await sb.from("screen_watch_events").update({ outcome: o.outcome, outcome_detail: o.detail, outcome_at: new Date(nowMs).toISOString() }).eq("id", e.id).is("outcome", null);
    if (!u.error) n++;
  }
  return { ok: true, filled: n };
}

// ─── 週のまとめ（search-audit-weekly・月曜 JST 9:00） ──────────────────────

export const WEEKLY_WATCH_PROMPT = `あなたは不動産の物件検索を自動で行う Chrome 拡張の「見張り」の週のまとめ係です。
渡すのは直近7日の見張りの数（ラベル別・段ごとの当たり／誤警報／見逃し・抜けやすい駅・裁定）です。スタッフ（エンジニアではない）が読んで
「今週どこを直すか」を決められるよう、日本語で短く。材料に無いことは書かない。JSON だけを返す: {"summary_ja":"全体を2〜3文","points":["直す所1文",…最大3]}`;

export async function weeklyScreenWatch(opts: { dry?: boolean; nowMs?: number } = {}): Promise<Record<string, unknown>> {
  const nowMs = opts.nowMs ?? Date.now();
  const sb = admin();
  if (!sb) return { ok: true, skipped: "no_service_role" };
  const since7 = new Date(nowMs - 7 * 86400_000).toISOString();
  const { data, error } = await sb.from("screen_watch_events").select("final_label, det_label, jev_label, jev_prob, ds_label, checkpoint, outcome, cost_usd, arbiter, material, site, det_rules").gte("created_at", since7).limit(5000);
  if (error) return missing(error) ? { ok: true, skipped: "no_table" } : { ok: false, error: error.message };
  const rows = (data ?? []) as Array<EventLite & { det_rules: string[] | null }>;
  const stats = weeklyWatchStats(rows);
  // 提案（原因ごとの一覧にそのまま出す）: 誤警報の多い規則・抜けやすい通勤の目的
  const proposals: string[] = [];
  const fa = new Map<string, number>();
  for (const r of rows) if (r.outcome === "false_alarm") for (const k of (r.det_rules ?? []).slice(0, 1)) fa.set(k, (fa.get(k) ?? 0) + 1);
  for (const [k, n] of [...fa.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) if (n >= 3) proposals.push(`watch_rule:${k.replace(/:/g, "_")}`);
  for (const m of stats.missingPlaces.slice(0, 3)) if (m.n >= 2) proposals.push(`decision:commute_missing:${m.name}`);
  let summary: { summary_ja: string; points: string[] } | null = null;
  let tuned: string | null = null;
  if (!opts.dry) {
    if (proposals.length) {
      const { bumpCauses } = await import("@/app/lib/search-audit-server");
      await bumpCauses(proposals, `watch_${jstDate(nowMs)}`, null, new Date(nowMs).toISOString()).catch(() => undefined);
    }
    if ((process.env.DEEPSEEK_API_KEY ?? "").trim() && rows.length) {
      const { callDeepSeekRead } = await import("@/app/lib/vision-alt-provider");
      const { DEEPSEEK_FLASH_MODEL } = await import("@/app/lib/llm-alt-provider");
      const parse = (t: string) => { const a = t.indexOf("{"), b = t.lastIndexOf("}"); try { const j = JSON.parse(t.slice(a, b + 1)); return typeof j.summary_ja === "string" ? { summary_ja: String(j.summary_ja).slice(0, 600), points: Array.isArray(j.points) ? j.points.slice(0, 3).map((x: unknown) => String(x).slice(0, 200)) : [] } : null; } catch { return null; } };
      const r = await callDeepSeekRead(WEEKLY_WATCH_PROMPT, JSON.stringify(stats).slice(0, 6000), { maxTokens: 500, timeoutMs: 30_000, model: DEEPSEEK_FLASH_MODEL }, parse, { retryIf: (e) => e < 25_000 });
      await recordUsage("screen_watch_weekly", DEEPSEEK_FLASH_MODEL, r.attempts as never, "【見張り・週のまとめ】", 500);
      summary = r.value;
    }
    // 線の自動調整（件数の幅の倍率・Jev から DeepSeek に回す線の2つだけ）。止める鍵は SCREEN_WATCH_AUTO_TUNE=off
    const cfg = readWatchConfig();
    const since28 = new Date(nowMs - 28 * 86400_000).toISOString();
    const all = await sb.from("screen_watch_events").select("final_label, det_label, jev_label, jev_prob, outcome, material").gte("created_at", since28).not("outcome", "is", null).limit(10000);
    if (!all.error) {
      const cur = (await loadThresholds()).t;
      const tc = tuneCountThresholds((all.data ?? []) as EventLite[], cur);
      const tj = tuneJevGate((all.data ?? []) as EventLite[]);
      const next = { ...(tc?.thresholds ?? cur), ...(tj ? { jevGateProb: tj.prob } : {}) };
      if (tc || (tj && tj.prob !== cur.jevGateProb)) {
        const reason = [tc?.reason, tj ? `Jev の線 ${cur.jevGateProb ?? "なし"}→${tj.prob}（見逃し率 ${tj.missRate}・${tj.n}行）` : null].filter(Boolean).join("／");
        const status = cfg.autoTune ? "active" : "proposed";
        if (cfg.autoTune) await sb.from("screen_watch_settings").update({ status: "retired" }).eq("status", "active");
        const ins = await sb.from("screen_watch_settings").insert({ status, thresholds: next, backtest: { count: tc?.backtest ?? null, jev: tj }, reason });
        tuned = ins.error ? `書けない: ${ins.error.message}` : `${status}: ${reason}`;
        _settings = null;
      }
    }
  }
  return { ok: true, events: rows.length, stats, proposals, summary, tuned };
}

// ─── 見張りの画面（GET /api/screen-watch?view=live） ───────────────────────

export async function liveView(nowMs = Date.now()): Promise<Record<string, unknown>> {
  const sb = admin();
  if (!sb) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い（見張りの表はサービスロールだけ）" };
  const cfg = readWatchConfig();
  const since20 = new Date(nowMs - 20 * 60_000).toISOString();
  const since7 = new Date(nowMs - 7 * 86400_000).toISOString();
  const [runs, evs, anomalies, snaps, spend] = await Promise.all([
    sb.from("search_audits").select("run_id, created_at, property_customer_id, site, trigger, is_wide, steps, ext_version").eq("status", "started").gte("created_at", since20).order("created_at", { ascending: false }).limit(5),
    sb.from("screen_watch_events").select("id, created_at, run_id, property_customer_id, site, checkpoint, det_label, det_hard, jev_label, jev_prob, ds_label, ds_image, ds_note, arbiter, final_label, action, action_reason, budget_state, cost_usd, outcome, material").order("created_at", { ascending: false }).limit(30),
    sb.from("screen_watch_events").select("id, created_at, property_customer_id, site, checkpoint, final_label, action, outcome, arbiter, material").neq("final_label", "normal").gte("created_at", since7).order("created_at", { ascending: false }).limit(200),
    sb.from("extension_snapshots").select("id, created_at, install_id, trigger, tabs").eq("kind", "result").order("created_at", { ascending: false }).limit(10),
    todaySpend(nowMs),
  ]);
  const tableMissing = !!(evs.error && missing(evs.error));
  const pcids = new Set<string>();
  for (const r of [...((runs.data ?? []) as Array<{ property_customer_id: string | null }>), ...((evs.data ?? []) as Array<{ property_customer_id: string | null }>), ...((anomalies.data ?? []) as Array<{ property_customer_id: string | null }>)]) if (r.property_customer_id) pcids.add(r.property_customer_id);
  const names: Record<string, string> = {};
  if (pcids.size) {
    const c = await sb.from("property_customers").select("id, customer_name").in("id", [...pcids].slice(0, 200));
    for (const r of (c.data ?? []) as Array<{ id: string; customer_name: string | null }>) names[r.id] = r.customer_name ?? "";
  }
  const byLabel: Record<string, { n: number; hit: number; false_alarm: number; pending: number }> = {};
  for (const a of (anomalies.data ?? []) as Array<{ final_label: string; outcome: string | null }>) {
    const b = (byLabel[a.final_label] ??= { n: 0, hit: 0, false_alarm: 0, pending: 0 });
    b.n++;
    if (a.outcome === "hit") b.hit++; else if (a.outcome === "false_alarm") b.false_alarm++; else b.pending++;
  }
  const lastShot: Record<string, { id: number; created_at: string; image_url: string | null; trigger: string | null }> = {};
  for (const s of (snaps.data ?? []) as Array<{ id: number; created_at: string; install_id: string | null; trigger: string | null; tabs: Array<Record<string, unknown>> | null }>) {
    const k = s.install_id ?? "-";
    if (lastShot[k]) continue;
    const img = (s.tabs ?? []).find((t) => typeof t.image_url === "string")?.image_url as string | undefined;
    lastShot[k] = { id: s.id, created_at: s.created_at, image_url: img ?? null, trigger: s.trigger };
  }
  const spent = Number.isFinite(spend.usd) ? +spend.usd.toFixed(4) : null;
  return {
    ok: true, config: cfg, table_missing: tableMissing, names,
    runs: (runs.data ?? []).map((r) => { const x = r as Record<string, unknown>; const steps = Array.isArray(x.steps) ? x.steps as Array<{ k?: string }> : []; return { ...x, steps: undefined, last_step: steps.length ? steps[steps.length - 1]?.k ?? null : null }; }),
    events: evs.data ?? [],
    anomalies: { by_label: byLabel, recent: ((anomalies.data ?? []) as unknown[]).slice(0, 15) },
    last_shot: lastShot,
    cost: { spent_usd: spent, cap_usd: cfg.dailyUsd, capped: spent == null || spent >= cfg.dailyUsd, counts: spend.counts, error: spend.error },
  };
}

/** 見張りの画面のボタン「一時調整で再検索」: 裁定の抜け（駅・区）をこの回だけ足して web_brain の検索を1つ積む（1人1日1回・全体で1日5回まで） */
export async function reSearchTemp(eventId: number, requestedBy: string | null, nowMs = Date.now()): Promise<{ ok: boolean; commandId?: string; error?: string }> {
  const sb = admin();
  if (!sb) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" };
  const { data, error } = await sb.from("screen_watch_events").select("id, property_customer_id, site, arbiter, material").eq("id", eventId).maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "その見張りの行がありません" };
  const e = data as { property_customer_id: string | null; site: string | null; arbiter: { missing?: string[] } | null; material: { decision_missing?: string[] } | null };
  if (!e.property_customer_id || !e.site || e.site === "reins") return { ok: false, error: "お客様・サイト（リアプロ／ITANDI）が分からない" };
  const want = [...(e.arbiter?.missing ?? []), ...(e.material?.decision_missing ?? [])];
  const { sanitizeSearchOverride } = await import("@/app/lib/search-override-read");
  const { normWard } = await import("@/app/lib/osaka-geo");
  const ov = sanitizeSearchOverride({ location: { mode: "add", stations: want.filter((w) => !normWard(w)), lines: [], areas: want.filter((w) => !!normWard(w)) }, is_wide: false });
  if (!ov) return { ok: false, error: "足す駅・区が読めない（手で一時調整してください）" };
  const dayStart = jstDayStartIso(nowMs);
  const { WEB_BRAIN_SOURCE } = await import("@/app/lib/web-brain-search");
  const today = await sb.from("automation_commands").select("id, customer_ids").eq("payload->>source", WEB_BRAIN_SOURCE).eq("payload->>watch_re_search", "true").gte("created_at", dayStart).limit(50);
  if (today.error) return { ok: false, error: today.error.message };
  const list = (today.data ?? []) as Array<{ customer_ids: string[] | null }>;
  if (list.length >= 5) return { ok: false, error: "今日の見張りの再検索は5回まで" };
  if (list.some((c) => (c.customer_ids ?? []).includes(e.property_customer_id!))) return { ok: false, error: "このお客様は今日もう再検索した（1人1日1回）" };
  const ins = await sb.from("automation_commands").insert({
    command_type: "batch_property_search", customer_ids: [e.property_customer_id], sites: [e.site === "realpro" ? "realnetpro" : e.site], status: "pending",
    payload: { source: WEB_BRAIN_SOURCE, is_wide: false, search_override: ov, watch_re_search: "true", watch_event_id: eventId, requested_by: requestedBy ? requestedBy.slice(0, 40) : null },
  }).select("id").single();
  if (ins.error) return { ok: false, error: ins.error.message };
  return { ok: true, commandId: (ins.data as { id: string }).id };
}
