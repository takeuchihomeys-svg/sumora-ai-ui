// app/lib/search-audit-server.ts
// 検索の点検（サーバー側）: search_audits（1回ごと）と search_audit_causes（原因ごと）の読み書き・DeepSeek の見立て・見回り・週のまとめ。
// 決まり（純関数）は search-audit-check.ts、見立ての文は search-audit-diagnose.ts。ここは DB と順番だけ。
//
// 2026-09-25 竹内「ブレインモードで物件自動検索や一括検索した際に、検索がちゃんとされていなかったら原因を見つけられるようにする」
// 静かに壊れないために: DB の error は全部見て返す（data ?? [] で握り潰さない）・見立ては「成功して保存した数」を返す。
import { supabase } from "@/app/lib/supabase";
import { callDeepSeekRead } from "@/app/lib/vision-alt-provider";
import { DEEPSEEK_FLASH_MODEL } from "@/app/lib/llm-alt-provider";
import {
  runSearchAuditChecks, needsDiagnosis, causeTitle, normalizeSite, versionGte, auditHeadline, parseMan,
  type AuditCheck, type AuditInput, type AuditSeverity,
} from "@/app/lib/search-audit-check";
import { diagnoseSearchAudit, SEARCH_AUDIT_ACTION, type SearchAuditDiagnosis } from "@/app/lib/search-audit-diagnose";

export const STALL_MINUTES = 20;
export const REUSE_DIAGNOSIS_DAYS = 7;
const MAX_JSON_CHARS = 24_000;

const TRIGGERS = new Set(["bulk_queue", "bulk_manual", "single", "scrape_compare", "web_brain"]);
const MODES = new Set(["brain_normal", "brain_staff", "brain_aix"]);

export type SearchAuditRow = {
  run_id: string;
  created_at: string;
  finished_at: string | null;
  status: "started" | "finished" | "abandoned";
  property_customer_id: string | null;
  site: string | null;
  mode: string | null;
  trigger: string | null;
  command_id: string | null;
  is_wide: boolean | null;
  area_mode: string | null;
  pass: string | null;
  customer_snapshot: Record<string, unknown> | null;
  intended: Record<string, unknown> | null;
  filled: Record<string, unknown> | null;
  steps: Array<Record<string, unknown>> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  error_kind: string | null;
  page_url: string | null;
  ext_version: string | null;
  checks: AuditCheck[] | null;
  severity: AuditSeverity | null;
  cause_key: string | null;
  ai_status: string | null;
  ai_diagnosis: Record<string, unknown> | null;
};

export type CauseRow = {
  cause_key: string;
  title: string | null;
  site: string | null;
  count_7d: number;
  count_total: number;
  first_seen: string | null;
  last_seen: string | null;
  example_run_ids: string[] | null;
  fix_hint: string | null;
  status: "open" | "fixed" | "ignored";
  fixed_in_version: string | null;
  fixed_at: string | null;
  note: string | null;
};

/** run_id の形（拡張の newRunId・英数と _ - だけ・64字まで） */
export function validRunId(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(s);
}

/** JSON の欄を大きさで切る（大きすぎる時は捨てて印だけ残す） */
function capJson<T>(v: T): T | { truncated: true } | null {
  if (v == null) return null;
  try {
    const s = JSON.stringify(v);
    if (s.length <= MAX_JSON_CHARS) return v;
    return { truncated: true };
  } catch { return null; }
}

function str(v: unknown, n: number): string | null {
  if (v == null || v === "") return null;
  return String(v).slice(0, n);
}

/** 受け取った本文 → 列（知らない欄は捨てる・純関数） */
export function rowFromBody(b: Record<string, unknown>): Partial<SearchAuditRow> {
  const out: Partial<SearchAuditRow> = {};
  const site = normalizeSite(typeof b.site === "string" ? b.site : null);
  if (site) out.site = site;
  if (typeof b.property_customer_id === "string" || typeof b.property_customer_id === "number") out.property_customer_id = String(b.property_customer_id).slice(0, 64);
  if (typeof b.mode === "string" && MODES.has(b.mode)) out.mode = b.mode;
  if (typeof b.trigger === "string" && TRIGGERS.has(b.trigger)) out.trigger = b.trigger;
  if (b.command_id != null) out.command_id = str(b.command_id, 64);
  if (typeof b.is_wide === "boolean") out.is_wide = b.is_wide;
  if (typeof b.area_mode === "string") out.area_mode = b.area_mode.slice(0, 20);
  if (typeof b.pass === "string") out.pass = b.pass.slice(0, 20);
  if (b.customer_snapshot && typeof b.customer_snapshot === "object") {
    // 名前・電話は入れない（拡張でも除いているが、サーバーでも欄を落とす）
    const cs = { ...(b.customer_snapshot as Record<string, unknown>) };
    for (const k of ["customer_name", "name", "phone", "tel", "line_user_id", "line_display_name", "email"]) delete cs[k];
    out.customer_snapshot = capJson(cs) as Record<string, unknown>;
  }
  if (b.intended && typeof b.intended === "object") out.intended = capJson(b.intended) as Record<string, unknown>;
  if (b.filled && typeof b.filled === "object") out.filled = capJson(b.filled) as Record<string, unknown>;
  if (Array.isArray(b.steps)) out.steps = (b.steps as Array<Record<string, unknown>>).slice(-40);
  if (b.result && typeof b.result === "object") out.result = capJson(b.result) as Record<string, unknown>;
  if (b.error != null) out.error = str(b.error, 1000);
  if (b.error_kind != null) out.error_kind = str(b.error_kind, 40);
  if (b.page_url != null) out.page_url = str(b.page_url, 500);
  if (b.ext_version != null) out.ext_version = str(b.ext_version, 20);
  return out;
}

async function loadRow(runId: string): Promise<{ row: SearchAuditRow | null; error: string | null }> {
  const { data, error } = await supabase.from("search_audits").select("*").eq("run_id", runId).maybeSingle();
  return { row: (data as SearchAuditRow | null) ?? null, error: error?.message ?? null };
}

/** phase=started: 無ければ入れる・あれば足す（終わった回の status は戻さない） */
export async function recordStarted(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const runId = body.run_id as string;
  const cols = rowFromBody(body);
  const { row, error } = await loadRow(runId);
  if (error) return { ok: false, error };
  if (!row) {
    const ins = await supabase.from("search_audits").insert({ run_id: runId, status: "started", ...cols });
    if (!ins.error) return { ok: true };
    // 同時に2通（background と popup）が入れた時は、もう片方が入れた行に足す
    if (!/duplicate|unique/i.test(ins.error.message)) return { ok: false, error: ins.error.message };
  }
  const upd = await supabase.from("search_audits").update(cols).eq("run_id", runId);
  return upd.error ? { ok: false, error: upd.error.message } : { ok: true };
}

/** 原因の表に数を足す（同じ回の原因の鍵ごとに1つ） */
export async function bumpCauses(keys: string[], runId: string, site: string | null, atIso: string): Promise<{ ok: number; errors: string[] }> {
  const errors: string[] = [];
  let ok = 0;
  for (const key of keys) {
    const { data, error } = await supabase.from("search_audit_causes").select("cause_key, count_total, count_7d, example_run_ids").eq("cause_key", key).maybeSingle();
    if (error) { errors.push(error.message); continue; }
    if (!data) {
      const ins = await supabase.from("search_audit_causes").insert({
        cause_key: key, title: causeTitle(key), site, count_7d: 1, count_total: 1,
        first_seen: atIso, last_seen: atIso, example_run_ids: [runId], status: "open",
      });
      if (ins.error && !/duplicate|unique/i.test(ins.error.message)) { errors.push(ins.error.message); continue; }
      if (!ins.error) { ok++; continue; }
    }
    const cur = (data ?? { count_total: 0, count_7d: 0, example_run_ids: [] }) as { count_total: number; count_7d: number; example_run_ids: string[] | null };
    const ex = [runId, ...(cur.example_run_ids ?? []).filter((x) => x !== runId)].slice(0, 5);
    const upd = await supabase.from("search_audit_causes").update({
      count_total: (cur.count_total ?? 0) + 1, count_7d: (cur.count_7d ?? 0) + 1, last_seen: atIso, example_run_ids: ex,
    }).eq("cause_key", key);
    if (upd.error) errors.push(upd.error.message); else ok++;
  }
  return { ok, errors };
}

function toAuditInput(row: Partial<SearchAuditRow>): AuditInput {
  return {
    site: row.site ?? null, status: row.status ?? null, trigger: row.trigger ?? null, is_wide: row.is_wide ?? null, area_mode: row.area_mode ?? null,
    customer_snapshot: (row.customer_snapshot ?? null) as AuditInput["customer_snapshot"],
    intended: (row.intended ?? null) as AuditInput["intended"],
    filled: (row.filled ?? null) as AuditInput["filled"],
    steps: (row.steps ?? null) as AuditInput["steps"],
    result: (row.result ?? null) as AuditInput["result"],
    error: row.error ?? null, error_kind: row.error_kind ?? null, created_at: row.created_at ?? null,
  };
}

/** phase=finished: 足して点検し、原因を数える。見立てが要るかを返す */
export async function recordFinished(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; needsAi: boolean; severity?: AuditSeverity; cause_key?: string | null }> {
  const runId = body.run_id as string;
  const cols = rowFromBody(body);
  const { row, error } = await loadRow(runId);
  if (error) return { ok: false, error, needsAi: false };
  if (row && row.status !== "started") return { ok: true, needsAi: false, severity: row.severity ?? undefined, cause_key: row.cause_key }; // 2通目は数えない
  const nowIso = new Date().toISOString();
  const merged: Partial<SearchAuditRow> = { ...(row ?? {}), ...cols, status: "finished", finished_at: nowIso, created_at: row?.created_at ?? nowIso };
  const v = runSearchAuditChecks(toAuditInput(merged));
  const ai = needsDiagnosis(v);
  const patch = { ...cols, status: "finished" as const, finished_at: nowIso, checks: v.checks, severity: v.severity, cause_key: v.cause_key, ai_status: ai ? "pending" : "skipped" };
  const w = row
    ? await supabase.from("search_audits").update(patch).eq("run_id", runId).eq("status", "started").select("run_id")
    : await supabase.from("search_audits").insert({ run_id: runId, ...patch }).select("run_id");
  if (w.error) return { ok: false, error: w.error.message, needsAi: false };
  // 2026-09-25 反証: 同じ回の finished が2通同時に来た時・見回りが先に abandoned にした時は、条件付き UPDATE が0行＝もう片方が数えた（原因を二重に足さない・見立ても頼まない）
  if (!w.data || w.data.length === 0) return { ok: true, needsAi: false };
  const counted = v.checks.filter((c) => c.severity !== "ok");
  const keys = Array.from(new Set(counted.map((c) => c.cause_key))).slice(0, 10);
  const b = await bumpCauses(keys, runId, merged.site ?? null, nowIso);
  if (b.errors.length) console.warn("[search-audit] 原因の数を足せない:", b.errors.slice(0, 3).join(" / "));
  return { ok: true, needsAi: ai, severity: v.severity, cause_key: v.cause_key };
}

/** 見立て（同じ原因に7日以内の見立てがあれば呼ばずに写す）。結果の状態を返す */
export async function runDiagnosis(runId: string): Promise<{ status: "done" | "reused" | "failed" | "skipped"; error?: string }> {
  const { row, error } = await loadRow(runId);
  if (error) return { status: "failed", error };
  if (!row || (row.ai_status !== "pending" && row.ai_status !== "failed")) return { status: "skipped" };
  const checks = row.checks ?? [];
  if (row.cause_key) {
    const since = new Date(Date.now() - REUSE_DIAGNOSIS_DAYS * 86400_000).toISOString();
    const prev = await supabase.from("search_audits").select("run_id, ai_diagnosis").eq("cause_key", row.cause_key).eq("ai_status", "done")
      .gte("created_at", since).neq("run_id", runId).order("created_at", { ascending: false }).limit(1);
    if (prev.error) return { status: "failed", error: prev.error.message };
    const p = (prev.data ?? [])[0] as { run_id: string; ai_diagnosis: Record<string, unknown> | null } | undefined;
    if (p?.ai_diagnosis) {
      const upd = await supabase.from("search_audits").update({ ai_status: "reused", ai_diagnosis: { ...p.ai_diagnosis, reused_from: p.run_id } }).eq("run_id", runId);
      return upd.error ? { status: "failed", error: upd.error.message } : { status: "reused" };
    }
  }
  const snap = (row.customer_snapshot ?? {}) as Record<string, unknown>;
  const out = await diagnoseSearchAudit({
    site: row.site, trigger: row.trigger, mode: row.mode, is_wide: row.is_wide, area_mode: row.area_mode, checks,
    intended: row.intended as never, filled: row.filled as never, steps: row.steps as never, result: row.result as never, error: row.error,
    customer_area: typeof snap.desired_area === "string" ? snap.desired_area : null,
    customer_area_mode: typeof snap.area_mode === "string" ? snap.area_mode : null,
    customer_rent_max_man: parseMan(snap.rent_max ?? snap.max_rent),
  }, { runId });
  if (!out.diagnosis) {
    const upd = await supabase.from("search_audits").update({ ai_status: "failed", ai_diagnosis: { failed: true, attempts: out.attempts, at: new Date().toISOString() } }).eq("run_id", runId);
    return { status: "failed", error: upd.error?.message ?? "DeepSeek が読める答えを返さなかった" };
  }
  const d: SearchAuditDiagnosis & { model: string | null; at: string } = { ...out.diagnosis, model: out.model, at: new Date().toISOString() };
  const upd = await supabase.from("search_audits").update({ ai_status: "done", ai_diagnosis: d }).eq("run_id", runId);
  if (upd.error) return { status: "failed", error: upd.error.message };
  // 原因の表の「直し方の案」がまだ空なら入れる
  if (row.cause_key && d.fix_ja) {
    const c = await supabase.from("search_audit_causes").select("fix_hint").eq("cause_key", row.cause_key).maybeSingle();
    if (!c.error && c.data && !(c.data as { fix_hint: string | null }).fix_hint) {
      await supabase.from("search_audit_causes").update({ fix_hint: `${d.cause_ja}\n→ ${d.fix_ja}${d.where?.file ? `（${d.where.file}${d.where.function ? ` ${d.where.function}` : ""}）` : ""}`.slice(0, 800) }).eq("cause_key", row.cause_key);
    }
  }
  return { status: "done" };
}

/** 見回り（15分ごと）: 20分たっても終わらない回を abandoned に・見立ての残りを最大20件 */
export async function sweepSearchAudits(opts: { deadlineAt: number; limit?: number }): Promise<{ ok: boolean; abandoned: number; diagnosed: Record<string, number>; errors: string[] }> {
  const errors: string[] = [];
  const cutoff = new Date(Date.now() - STALL_MINUTES * 60_000).toISOString();
  const st = await supabase.from("search_audits").select("*").eq("status", "started").lt("created_at", cutoff).order("created_at", { ascending: true }).limit(50);
  if (st.error) return { ok: false, abandoned: 0, diagnosed: {}, errors: [st.error.message] };
  let abandoned = 0;
  for (const r of (st.data ?? []) as SearchAuditRow[]) {
    const nowIso = new Date().toISOString();
    const v = runSearchAuditChecks(toAuditInput({ ...r, status: "abandoned" }));
    const ai = needsDiagnosis(v);
    const upd = await supabase.from("search_audits").update({ status: "abandoned", finished_at: nowIso, checks: v.checks, severity: v.severity, cause_key: v.cause_key, ai_status: ai ? "pending" : "skipped" })
      .eq("run_id", r.run_id).eq("status", "started");
    if (upd.error) { errors.push(upd.error.message); continue; }
    abandoned++;
    const counted = v.checks.filter((c) => c.severity !== "ok");
    const b = await bumpCauses(Array.from(new Set(counted.map((c) => c.cause_key))).slice(0, 10), r.run_id, r.site, nowIso);
    errors.push(...b.errors);
  }
  const diagnosed: Record<string, number> = { done: 0, reused: 0, failed: 0, skipped: 0 };
  const pend = await supabase.from("search_audits").select("run_id").eq("ai_status", "pending").order("created_at", { ascending: true }).limit(opts.limit ?? 20);
  if (pend.error) errors.push(pend.error.message);
  for (const p of (pend.data ?? []) as Array<{ run_id: string }>) {
    if (Date.now() > opts.deadlineAt) break;
    const res = await runDiagnosis(p.run_id);
    diagnosed[res.status] = (diagnosed[res.status] ?? 0) + 1;
    if (res.error) errors.push(`${p.run_id}: ${res.error}`);
  }
  return { ok: errors.length === 0, abandoned, diagnosed, errors: errors.slice(0, 10) };
}

type CauseCount = { cause_key: string; count: number; bad: number; last_run: string; site: string | null; title: string };

/** 期間の中の原因ごとの数（checks の原因の鍵から数える・純関数） */
export function countCauses(rows: Array<Pick<SearchAuditRow, "run_id" | "created_at" | "site" | "checks">>): CauseCount[] {
  const m = new Map<string, CauseCount>();
  for (const r of rows) {
    const seen = new Set<string>();
    for (const c of r.checks ?? []) {
      if (c.severity === "ok" || seen.has(c.cause_key)) continue;
      seen.add(c.cause_key);
      const cur = m.get(c.cause_key) ?? { cause_key: c.cause_key, count: 0, bad: 0, last_run: r.run_id, site: r.site, title: causeTitle(c.cause_key) };
      cur.count++;
      if (c.severity === "bad") cur.bad++;
      cur.last_run = r.run_id;
      m.set(c.cause_key, cur);
    }
  }
  return Array.from(m.values()).sort((a, b) => b.bad - a.bad || b.count - a.count);
}

async function rowsSince(days: number, cols: string): Promise<{ rows: SearchAuditRow[]; error: string | null }> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await supabase.from("search_audits").select(cols).gte("created_at", since).order("created_at", { ascending: true }).limit(5000);
  return { rows: ((data ?? []) as unknown) as SearchAuditRow[], error: error?.message ?? null };
}

export type CauseView = CauseRow & {
  count_window: number; bad_window: number; count_30d: number; recurred: boolean;
  latest_diagnosis: Record<string, unknown> | null; latest_run_id: string | null;
};

/** 画面の「原因ごと」: 表の行＋期間の数（7日／30日）・直した版以降に出たら再発・最新の見立て */
export async function listCauses(days: number): Promise<{ causes: CauseView[]; runs_window: number; error: string | null }> {
  const [c, r30] = await Promise.all([
    supabase.from("search_audit_causes").select("*").order("last_seen", { ascending: false }).limit(300),
    rowsSince(Math.max(30, days), "run_id, created_at, site, checks, ext_version, cause_key, ai_status, ai_diagnosis"),
  ]);
  if (c.error) return { causes: [], runs_window: 0, error: c.error.message };
  if (r30.error) return { causes: [], runs_window: 0, error: r30.error };
  const winSince = Date.now() - days * 86400_000;
  const inWin = r30.rows.filter((x) => Date.parse(x.created_at) >= winSince);
  const w = new Map(countCauses(inWin).map((x) => [x.cause_key, x] as const));
  const m30 = new Map(countCauses(r30.rows).map((x) => [x.cause_key, x] as const));
  const causes: CauseView[] = ((c.data ?? []) as CauseRow[]).map((row) => {
    const hits = r30.rows.filter((x) => (x.checks ?? []).some((k) => k.cause_key === row.cause_key));
    // 見立ては回の一番重い原因（x.cause_key）について書かれている → その原因が一番重かった回の見立てだけを出す
    //   （2026-09-25 画面の確かめ: 「条件の読み落とし（walk）」に、同じ回の「途中で止まった」の見立てが💡で出ていた）
    const lastWithDiag = [...hits].reverse().find((x) => x.cause_key === row.cause_key && x.ai_diagnosis && (x.ai_status === "done" || x.ai_status === "reused"));
    // 再発: 「直した」を押した後に、直した版以上の拡張で同じ原因が出た（版が空なら押した後に出ただけで再発）
    const fixedAt = Date.parse(row.fixed_at ?? "");
    const recurred = row.status === "fixed" && Number.isFinite(fixedAt) && hits.some((x) =>
      Date.parse(x.created_at) > fixedAt && (!row.fixed_in_version || versionGte((x as SearchAuditRow).ext_version, row.fixed_in_version)));
    return {
      ...row,
      count_window: w.get(row.cause_key)?.count ?? 0,
      bad_window: w.get(row.cause_key)?.bad ?? 0,
      count_30d: m30.get(row.cause_key)?.count ?? 0,
      recurred,
      latest_diagnosis: lastWithDiag?.ai_diagnosis ?? null,
      latest_run_id: hits.length ? hits[hits.length - 1].run_id : null,
    };
  });
  causes.sort((a, b) => Number(b.recurred) - Number(a.recurred) || (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.bad_window - a.bad_window || b.count_window - a.count_window);
  return { causes, runs_window: inWin.length, error: null };
}

export type RunView = Pick<SearchAuditRow, "run_id" | "created_at" | "finished_at" | "status" | "property_customer_id" | "site" | "mode" | "trigger" | "is_wide" | "severity" | "cause_key" | "ai_status" | "ext_version" | "result"> & {
  headline: string | null; checks: AuditCheck[]; ai_diagnosis: Record<string, unknown> | null;
};

/** 画面の「回ごと」（お客様で絞れる） */
export async function listRuns(days: number, opts?: { customerId?: string | null; limit?: number }): Promise<{ runs: RunView[]; error: string | null }> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  let q = supabase.from("search_audits").select("run_id, created_at, finished_at, status, property_customer_id, site, mode, trigger, is_wide, severity, cause_key, ai_status, ext_version, result, checks, intended, ai_diagnosis")
    .gte("created_at", since).order("created_at", { ascending: false }).limit(Math.min(opts?.limit ?? 200, 500));
  if (opts?.customerId) q = q.eq("property_customer_id", opts.customerId);
  const { data, error } = await q;
  if (error) return { runs: [], error: error.message };
  const runs = ((data ?? []) as SearchAuditRow[]).map((r) => ({
    run_id: r.run_id, created_at: r.created_at, finished_at: r.finished_at, status: r.status, property_customer_id: r.property_customer_id,
    site: r.site, mode: r.mode, trigger: r.trigger, is_wide: r.is_wide, severity: r.severity, cause_key: r.cause_key, ai_status: r.ai_status,
    ext_version: r.ext_version, result: r.result, checks: r.checks ?? [], ai_diagnosis: r.ai_diagnosis,
    headline: auditHeadline({ severity: r.severity, intended: r.intended as never, checks: r.checks }),
  }));
  return { runs, error: null };
}

/** 画面のボタン（未対応／直した＋版／無視） */
export async function setCauseStatus(causeKey: string, status: "open" | "fixed" | "ignored", fixedInVersion: string | null, note: string | null): Promise<{ ok: boolean; error?: string }> {
  const patch: Record<string, unknown> = { status, fixed_in_version: status === "fixed" ? (fixedInVersion ?? null) : null };
  if (note != null) patch.note = note.slice(0, 1000);
  patch.fixed_at = status === "fixed" ? new Date().toISOString() : null; // 直した時点を「ここから先に出たら再発」の線にする
  const { error, data } = await supabase.from("search_audit_causes").update(patch).eq("cause_key", causeKey).select("cause_key");
  if (error) return { ok: false, error: error.message };
  if (!data || !data.length) return { ok: false, error: "その原因はありません" };
  return { ok: true };
}

// ── 週のまとめ（月曜 JST 9:00）──────────────────────────────────────────────
export const WEEKLY_SYSTEM_PROMPT = `あなたは不動産の物件検索を自動で行う Chrome 拡張の不具合を週ごとにまとめる係です。
渡すのは直近7日の「検索の点検」で多かった原因の上位（原因の鍵・件数・見立て）です。
スタッフ（エンジニアではない）が読んで「今週どれから直すか」を決められるよう、日本語で短くまとめてください。
推測で画面の部品の名前（クラス名・name 属性）を作らない。材料に無いことは書かない。
JSON だけを返す: {"summary_ja":"全体を2〜3文","priorities":[{"cause_key":"…","why_ja":"なぜ先に直すか1文","fix_ja":"直し方1文"}]}`;

export function parseWeekly(text: string): { summary_ja: string; priorities: Array<{ cause_key: string; why_ja: string; fix_ja: string }> } | null {
  const s = String(text ?? "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(s.slice(a, b + 1)) as { summary_ja?: unknown; priorities?: unknown };
    if (typeof j.summary_ja !== "string") return null;
    const pr = Array.isArray(j.priorities) ? j.priorities : [];
    return {
      summary_ja: j.summary_ja.slice(0, 600),
      priorities: pr.slice(0, 5).map((p) => {
        const o = (p ?? {}) as Record<string, unknown>;
        return { cause_key: String(o.cause_key ?? "").slice(0, 120), why_ja: String(o.why_ja ?? "").slice(0, 300), fix_ja: String(o.fix_ja ?? "").slice(0, 300) };
      }),
    };
  } catch { return null; }
}

/** 週のまとめ: 原因ごとの7日の数を付け直し、上位5件を DeepSeek で1回まとめる（LINE には送らない） */
export async function weeklySearchAudit(opts?: { dry?: boolean }): Promise<{ ok: boolean; runs: number; top: CauseCount[]; summary: ReturnType<typeof parseWeekly>; updated: number; errors: string[] }> {
  const errors: string[] = [];
  const { rows, error } = await rowsSince(7, "run_id, created_at, site, checks, cause_key, ai_diagnosis");
  if (error) return { ok: false, runs: 0, top: [], summary: null, updated: 0, errors: [error] };
  const counts = countCauses(rows);
  let updated = 0;
  if (!opts?.dry) {
    const all = await supabase.from("search_audit_causes").select("cause_key, count_7d");
    if (all.error) errors.push(all.error.message);
    const cm = new Map(counts.map((x) => [x.cause_key, x.count] as const));
    for (const c of (all.data ?? []) as Array<{ cause_key: string; count_7d: number }>) {
      const n = cm.get(c.cause_key) ?? 0;
      if (n === c.count_7d) continue;
      const u = await supabase.from("search_audit_causes").update({ count_7d: n }).eq("cause_key", c.cause_key);
      if (u.error) errors.push(u.error.message); else updated++;
    }
  }
  const top = counts.slice(0, 5);
  let summary: ReturnType<typeof parseWeekly> = null;
  if (top.length && !opts?.dry) {
    const lines = top.map((t, k) => {
      const withDiag = [...rows].reverse().find((r) => r.cause_key === t.cause_key && r.ai_diagnosis && !(r.ai_diagnosis as { failed?: boolean }).failed);
      const d = (withDiag?.ai_diagnosis ?? null) as Partial<SearchAuditDiagnosis> | null;
      return `${k + 1}. ${t.cause_key}（${t.title}）: ${t.count}回（うち重い${t.bad}回）${d?.cause_ja ? ` 見立て: ${d.cause_ja}` : ""}${d?.fix_ja ? ` 直し方の案: ${d.fix_ja}` : ""}`;
    });
    const read = await callDeepSeekRead(WEEKLY_SYSTEM_PROMPT, `【直近7日の検索 ${rows.length}回・原因の上位】\n${lines.join("\n")}`, { maxTokens: 600, timeoutMs: 30_000, model: DEEPSEEK_FLASH_MODEL }, parseWeekly,
      // 読み直しは答えが崩れた時だけ（30秒の待ち切れは同じ原因で呼び直さない・maxDuration 120 にも収まる）
      { retryIf: (elapsedMs) => elapsedMs < 28_000 });
    for (const a of read.attempts) {
      void import("@/app/lib/llm-usage-recorder").then(({ recordAltUsage }) => recordAltUsage({
        model: a.res?.model ?? DEEPSEEK_FLASH_MODEL, action: SEARCH_AUDIT_ACTION, conversationId: null,
        usage: { input_tokens: Math.max(0, (a.res?.usage.input ?? 0) - (a.res?.usage.cacheHit ?? 0)), output_tokens: a.res?.usage.output ?? 0, cache_read_input_tokens: a.res?.usage.cacheHit ?? 0 },
        status: a.res ? 200 : 0, errorType: a.ok ? null : (a.res ? "empty_or_unparsable" : "no_response"),
        durationMs: a.ms, sysHead: `【検索の点検・週のまとめ${a.retry ? "・読み直し" : ""}】`, sysKeyFull: null, maxTokens: 600,
      })).catch(() => {});
    }
    summary = read.value;
    if (!summary) errors.push("週のまとめ: DeepSeek が読める答えを返さなかった");
  }
  return { ok: errors.length === 0, runs: rows.length, top, summary, updated, errors };
}

/** 最新の週のまとめ（cron_run_logs から） */
export async function latestWeekly(): Promise<{ at: string | null; result: Record<string, unknown> | null; error: string | null }> {
  const { data, error } = await supabase.from("cron_run_logs").select("finished_at, result_json").eq("cron_name", "search-audit-weekly").not("finished_at", "is", null)
    .order("finished_at", { ascending: false }).limit(1);
  if (error) return { at: null, result: null, error: error.message };
  const r = (data ?? [])[0] as { finished_at: string; result_json: Record<string, unknown> | null } | undefined;
  return { at: r?.finished_at ?? null, result: r?.result_json ?? null, error: null };
}
