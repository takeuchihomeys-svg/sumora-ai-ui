// app/lib/llm-budget-route-server.ts — 今月の使用額（Claude・OpenAI・DeepSeek）を llm_usage_logs から数える（5分の控え・前に読んだ行の続きだけ読む）
// 2026-11-24 作業員L（台帳 #670）。決まりは app/lib/llm-budget-route.ts。毎回 DB を数えない: 控えが5分より新しければ読まない。
//   古い時は、前に読んだ一番新しい id より後の行だけ足す（最初の1回だけ数え始めの時刻から全部）。読めない時は null（＝Claude のまま）
import type { SupabaseClient } from "@supabase/supabase-js";
import { claudeUsageUsd, altUsageUsd } from "./llm-price";
import { readBudgetConfig, spendWindowStart, claudeMonthSpendUsd, budgetDecision, budgetRoleOf, type BudgetDecision } from "./llm-budget-route";

export const BUDGET_CACHE_MS = 5 * 60_000;
type Sums = { since: string; lastId: number; claudeUsd: number; openaiUsd: number; deepseekUsd: number; readAt: number };
let cache: Sums | null = null;

const COLS = "id, model, created_at, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h, output_tokens";
type Row = { id: number; model: string | null; created_at: string; input_uncached: number | null; cache_read: number | null; cache_write: number | null; cache_write_5m: number | null; cache_write_1h: number | null; output_tokens: number | null };

/** 1行の費用を会社ごとに足す（純関数） */
export function addRow(s: Pick<Sums, "claudeUsd" | "openaiUsd" | "deepseekUsd">, r: Row): void {
  const m = String(r.model ?? "");
  if (/claude/.test(m)) s.claudeUsd += claudeUsageUsd(r);
  else if (/^gpt-|^text-embedding/.test(m)) s.openaiUsd += altUsageUsd(r);
  else if (/deepseek/.test(m)) s.deepseekUsd += altUsageUsd(r);
}

/**
 * 2026-11-25 作業員L（統括役の頼み・毎朝の1枚の月の費用が $142 と出て audit-llm-month-cost の $291 と食い違った）: 1回の読みは 50頁（5万行）まで。
 *   今月は 11/24 で 10万行を超え、毎朝の1枚（1回だけ読む）は月の半分で止まっていた。本番（5分の控えで続きを読む）は今まで通り 50頁・
 *   一回きりの読み（毎朝の1枚）は maxPages を大きく渡す。読み切れなかった時は partial=true
 */
export async function monthSums(sb: SupabaseClient, nowMs = Date.now(), env: Record<string, string | undefined> = process.env, o: { maxPages?: number } = {}): Promise<(Sums & { partial?: boolean }) | null> {
  const cfg = readBudgetConfig(env);
  const { since } = spendWindowStart(cfg, nowMs);
  if (cache && cache.since === since && nowMs - cache.readAt < BUDGET_CACHE_MS) return cache;
  const next: Sums = cache && cache.since === since ? { ...cache } : { since, lastId: 0, claudeUsd: 0, openaiUsd: 0, deepseekUsd: 0, readAt: 0 };
  try {
    let done = false;
    const maxPages = o.maxPages ?? 50;
    for (let page = 0; page < maxPages; page++) {
      let q = sb.from("llm_usage_logs").select(COLS).gte("created_at", since).order("id", { ascending: true }).limit(1000);
      if (next.lastId) q = q.gt("id", next.lastId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Row[];
      for (const r of rows) { addRow(next, r); next.lastId = Math.max(next.lastId, Number(r.id)); }
      if (rows.length < 1000) { done = true; break; }
    }
    (next as Sums & { partial?: boolean }).partial = !done;
  } catch (e) {
    console.warn("[llm-budget] 使用額を読めない:", e instanceof Error ? e.message : String(e));
    return cache && cache.since === since ? cache : null;
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

/** 名札の振り分け（off の時は DB を読まない） */
export async function budgetDecisionFor(sb: SupabaseClient, routeName: string | null, nowMs = Date.now(), env: Record<string, string | undefined> = process.env, ctx: { httpRoute?: string | null; claudeModel?: string | null } = {}): Promise<BudgetDecision> {
  const cfg = readBudgetConfig(env);
  if (cfg.mode === "off" || cfg.switchAtUsd == null) return budgetDecision(routeName, null, cfg, ctx);
  // 表に無い名札は DB を読まない（Claude のまま）
  if (!budgetRoleOf(routeName, ctx)) return budgetDecision(routeName, null, cfg, ctx);
  const s = await monthSums(sb, nowMs, env);
  const spend = s ? claudeMonthSpendUsd(cfg, { useBase: spendWindowStart(cfg, nowMs).useBase, sinceUsd: s.claudeUsd }) : null;
  return budgetDecision(routeName, spend, cfg, { ...ctx, partial: !!s?.partial });
}
/** 2026-11-25: 今のリクエストの経路（"/api/cron/brain-sweep" 等・Next の作業情報・取れなければ null） */
export async function httpRouteNow(): Promise<string | null> {
  try { const mod = await import("next/dist/server/app-render/work-async-storage.external"); return ((mod as unknown as { workAsyncStorage?: { getStore(): { route?: string } | undefined } }).workAsyncStorage?.getStore()?.route) ?? null; } catch { return null; }
}

export function resetBudgetCache(): void { cache = null; }
