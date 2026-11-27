// app/lib/llm-budget-route-server.ts — 今月の使用額（Claude・OpenAI・DeepSeek）を llm_usage_logs から数える（5分の控え・前に読んだ行の続きだけ読む）
// 2026-11-24 作業員L（台帳 #670）。決まりは app/lib/llm-budget-route.ts。毎回 DB を数えない: 控えが5分より新しければ読まない。
//   古い時は、前に読んだ一番新しい id より後の行だけ足す（最初の1回だけ数え始めの時刻から全部）。読めない時は null（＝Claude のまま）
import type { SupabaseClient } from "@supabase/supabase-js";
import { claudeUsageUsd, altUsageUsd } from "./llm-price";
import { readBudgetConfig, spendWindowStart, openaiWindowStart, claudeMonthSpendUsd, budgetDecision, budgetRoleOf, type BudgetDecision } from "./llm-budget-route";

export const BUDGET_CACHE_MS = 5 * 60_000;
// 2026-11-25 統括役の頼み（本番と試験を混ぜた誤りの直し）: 本番（route が script: でない行）の分も持つ。振り分けの決めは特典を食う全部の額（試験も同じ鍵）で、見せる所は本番と試験を分ける
type Sums = { since: string; lastId: number; claudeUsd: number; openaiUsd: number; deepseekUsd: number; readAt: number; key?: string; prod?: { claudeUsd: number; openaiUsd: number; deepseekUsd: number } };
let cache: Sums | null = null;

const COLS = "id, model, route, created_at, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h, output_tokens";
type Row = { id: number; model: string | null; created_at: string; input_uncached: number | null; cache_read: number | null; cache_write: number | null; cache_write_5m: number | null; cache_write_1h: number | null; output_tokens: number | null };

/** 1行の費用を会社ごとに足す（純関数） */
export function addRow(s: Pick<Sums, "claudeUsd" | "openaiUsd" | "deepseekUsd">, r: Row): void {
  const m = String(r.model ?? "");
  if (/claude/.test(m)) s.claudeUsd += claudeUsageUsd(r);
  else if (/^gpt-|^text-embedding/.test(m)) s.openaiUsd += altUsageUsd(r);
  else if (/deepseek/.test(m)) s.deepseekUsd += altUsageUsd(r);
}

// ─── 2026-11-27 作業員L（統括役の決め「冷えた関数ごとに月の行を最大5万行読む作りを直す・DB の構造は変えない」）──────────────
//   毎時1回、5分ごとの cron（ops-anomaly）が月の合計を quality_daily に1行の控え（scope=all・metric=budget:month_sums・その日の1行を上書き）として書く。
//   冷えた関数は控えの1行を読み、控えの後の行（id が控えより大きい物）だけ足す。控えが無い・古い（3時間より前）・区切りが違う時は今まで通り。止める BUDGET_SNAPSHOT=off
export const BUDGET_SNAPSHOT_METRIC = "budget:month_sums";
export const BUDGET_SNAPSHOT_MAX_AGE_MS = 3 * 3_600_000;
export const budgetSnapshotOn = (env: Record<string, string | undefined> = process.env) => String(env.BUDGET_SNAPSHOT ?? "").trim().toLowerCase() !== "off";
/** 控えの1行（detail）→ 始めの数え（純関数）。区切りの鍵が同じで新しい時だけ。読んだ時刻は 0（すぐ続きを読む） */
export function budgetSnapshotSeedOf(detail: unknown, key: string, nowMs: number): Sums | null {
  const d = (detail ?? null) as Partial<Sums> & { at?: number } | null;
  if (!d || d.key !== key || typeof d.lastId !== "number" || !(d.lastId > 0) || typeof d.at !== "number" || nowMs - d.at > BUDGET_SNAPSHOT_MAX_AGE_MS || d.at > nowMs + 60_000) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { since: String(d.since ?? ""), key, lastId: d.lastId, claudeUsd: n(d.claudeUsd), openaiUsd: n(d.openaiUsd), deepseekUsd: n(d.deepseekUsd), readAt: 0,
    prod: { claudeUsd: n(d.prod?.claudeUsd), openaiUsd: n(d.prod?.openaiUsd), deepseekUsd: n(d.prod?.deepseekUsd) } };
}
/** 書く回か（純関数）: 毎時0〜4分の回だけ（5分ごとの cron で1時間に1回） */
export const budgetSnapshotDue = (nowMs: number) => new Date(nowMs).getUTCMinutes() < 5;
/** 控えを書く（5分ごとの cron から・毎時1回）。読み切れなかった時（partial）は書かない */
export async function writeBudgetSnapshot(sb: SupabaseClient, nowMs = Date.now(), env: Record<string, string | undefined> = process.env): Promise<{ written: boolean; why: string }> {
  if (!budgetSnapshotOn(env)) return { written: false, why: "BUDGET_SNAPSHOT=off" };
  const s = await monthSums(sb, nowMs, env, { maxPages: 200 });
  if (!s) return { written: false, why: "使用額を読めない" };
  if (s.partial) return { written: false, why: "読み切れていない" };
  const day = new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);
  const detail = { since: s.since, key: s.key, lastId: s.lastId, claudeUsd: s.claudeUsd, openaiUsd: s.openaiUsd, deepseekUsd: s.deepseekUsd, prod: s.prod, at: nowMs };
  const { error } = await sb.from("quality_daily").upsert({ day, metric: BUDGET_SNAPSHOT_METRIC, scope: "all", value: Math.round(s.openaiUsd * 100) / 100, n: s.lastId, source: "llm-budget", detail }, { onConflict: "day,metric,scope" });
  return error ? { written: false, why: error.message.slice(0, 80) } : { written: true, why: "ok" };
}

/**
 * 2026-11-25 作業員L（統括役の頼み・毎朝の1枚の月の費用が $142 と出て audit-llm-month-cost の $291 と食い違った）: 1回の読みは 50頁（5万行）まで。
 *   今月は 11/24 で 10万行を超え、毎朝の1枚（1回だけ読む）は月の半分で止まっていた。本番（5分の控えで続きを読む）は今まで通り 50頁・
 *   一回きりの読み（毎朝の1枚）は maxPages を大きく渡す。読み切れなかった時は partial=true
 */
export async function monthSums(sb: SupabaseClient, nowMs = Date.now(), env: Record<string, string | undefined> = process.env, o: { maxPages?: number } = {}): Promise<(Sums & { partial?: boolean }) | null> {
  const cfg = readBudgetConfig(env, nowMs);
  // 2026-11-25 2つの枠: Claude は Claude の区切り（10日・基準）・OpenAI は OpenAI の区切り（暦の月初）から。読みは早い方から1回
  const claudeSince = spendWindowStart(cfg, nowMs).since, openaiSince = openaiWindowStart(cfg, nowMs);
  const since = claudeSince < openaiSince ? claudeSince : openaiSince;
  const key = `${claudeSince}|${openaiSince}`;
  if (cache && cache.key === key && nowMs - cache.readAt < BUDGET_CACHE_MS) return cache;
  let next: Sums = cache && cache.key === key ? { ...cache, prod: { ...(cache.prod ?? { claudeUsd: 0, openaiUsd: 0, deepseekUsd: 0 }) } } : { since, key, lastId: 0, claudeUsd: 0, openaiUsd: 0, deepseekUsd: 0, readAt: 0, prod: { claudeUsd: 0, openaiUsd: 0, deepseekUsd: 0 } };
  // 2026-11-27 作業員L（統括役の決め）: 冷えた関数（控えが無い）は、毎時の控えの1行（quality_daily の budget:month_sums）から始め、その後の行だけ読む。
  //   前は冷えた関数ごとに月の行を最大5万行読みに行き、米国（iad1）の関数では読み終わらず、回せる係も Claude のままだった（11/25〜27 に入口の読み 17回・確かめ 13回）
  if (!next.lastId && budgetSnapshotOn(env)) {
    try {
      const { data } = await sb.from("quality_daily").select("detail").eq("scope", "all").eq("metric", BUDGET_SNAPSHOT_METRIC).order("day", { ascending: false }).limit(1).maybeSingle();
      const seed = budgetSnapshotSeedOf((data as { detail?: unknown } | null)?.detail ?? null, key, nowMs);
      if (seed) next = seed;
    } catch { /* 控えが読めなければ今まで通り全部読む */ }
  }
  try {
    let done = false;
    const maxPages = o.maxPages ?? 50;
    for (let page = 0; page < maxPages; page++) {
      let q = sb.from("llm_usage_logs").select(COLS).gte("created_at", since).order("id", { ascending: true }).limit(1000);
      if (next.lastId) q = q.gt("id", next.lastId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Row[];
      for (const r of rows) {
        const at = String(r.created_at ?? ""), m = String(r.model ?? "");
        if (/claude/.test(m) ? at >= claudeSince : /^gpt-|^text-embedding/.test(m) ? at >= openaiSince : true) {
          addRow(next, r);
          if (!/^script:/.test(String((r as { route?: string | null }).route ?? ""))) addRow((next.prod ??= { claudeUsd: 0, openaiUsd: 0, deepseekUsd: 0 }), r);
        }
        next.lastId = Math.max(next.lastId, Number(r.id));
      }
      if (rows.length < 1000) { done = true; break; }
    }
    (next as Sums & { partial?: boolean }).partial = !done;
  } catch (e) {
    console.warn("[llm-budget] 使用額を読めない:", e instanceof Error ? e.message : String(e));
    return cache && cache.key === key ? cache : null;
  }
  next.readAt = nowMs;
  cache = next;
  return cache;
}

/** 今月の Claude の使用額（基準＋補正）。読めなければ null */
export async function claudeSpendNow(sb: SupabaseClient, nowMs = Date.now(), env: Record<string, string | undefined> = process.env): Promise<number | null> {
  const cfg = readBudgetConfig(env);
  const s = await monthSums(sb, nowMs, env);
  if (!s) return null;
  return claudeMonthSpendUsd(cfg, { useBase: spendWindowStart(cfg, nowMs).useBase, sinceUsd: s.claudeUsd });
}

let refreshing: Promise<unknown> | null = null;
/** 控えをすぐ返す（無い・古い時は裏で読み直し・読み直し中に2本目を走らせない）。控えが無ければ null＝この呼び出しは Claude のまま */
export function budgetSumsNoWait(sb: SupabaseClient, nowMs = Date.now(), env: Record<string, string | undefined> = process.env): (Sums & { partial?: boolean }) | null {
  const fresh = cache && nowMs - cache.readAt < BUDGET_CACHE_MS;
  if (!fresh && !refreshing) {
    refreshing = monthSums(sb, nowMs, env).catch(() => null).finally(() => { refreshing = null; });
    try { void import("@vercel/functions").then((m) => { try { if (refreshing) m.waitUntil(refreshing); } catch { /* Vercel の外 */ } }); } catch { /* */ }
  }
  return cache;
}
/** 名札の振り分け（off の時は DB を読まない） */
export async function budgetDecisionFor(sb: SupabaseClient, routeName: string | null, nowMs = Date.now(), env: Record<string, string | undefined> = process.env, ctx: { httpRoute?: string | null; claudeModel?: string | null; piiWriter?: boolean } = {}): Promise<BudgetDecision> {
  const cfg = readBudgetConfig(env);
  if (cfg.mode === "off" || cfg.switchAtUsd == null) return budgetDecision(routeName, null, cfg, ctx);
  // 表に無い名札は DB を読まない（Claude のまま）
  if (!budgetRoleOf(routeName, { ...ctx, extra: cfg.extra })) return budgetDecision(routeName, null, cfg, ctx);
  // 2026-11-25 作業員L（本番の不具合・resolve_area の時間切れの元）: 月の数えの読み（最大 50頁×1000行）を呼び出しの前に待たない。
  //   控えが無い（冷えた関数）か古い時は裏で読み直し、その間は手元の控え（無ければ Claude のまま）で決める。
  //   11/25 07:14・07:27 UTC: resolve_area は LLM を呼ぶ前に 17秒以上かかり（米国 iad1 から東京の DB を数十回読む）、呼ぶ側が先に切れた
  const s = budgetSumsNoWait(sb, nowMs, env);
  const spend = s ? claudeMonthSpendUsd(cfg, { useBase: spendWindowStart(cfg, nowMs).useBase, sinceUsd: s.claudeUsd }) : null;
  return budgetDecision(routeName, spend, cfg, { ...ctx, partial: !!s?.partial, openaiUsd: s ? s.openaiUsd : null });
}
/** 2026-11-25: 今のリクエストの経路（"/api/cron/brain-sweep" 等・Next の作業情報・取れなければ null） */
export async function httpRouteNow(): Promise<string | null> {
  try { const mod = await import("next/dist/server/app-render/work-async-storage.external"); return ((mod as unknown as { workAsyncStorage?: { getStore(): { route?: string } | undefined } }).workAsyncStorage?.getStore()?.route) ?? null; } catch { return null; }
}

export function resetBudgetCache(): void { cache = null; }
