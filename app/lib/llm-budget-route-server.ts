// app/lib/llm-budget-route-server.ts — 今月の使用額（Claude・OpenAI・DeepSeek）を llm_usage_logs から数える（5分の控え・前に読んだ行の続きだけ読む）
// 2026-11-24 作業員L（台帳 #670）。決まりは app/lib/llm-budget-route.ts。毎回 DB を数えない: 控えが5分より新しければ読まない。
//   古い時は、前に読んだ一番新しい id より後の行だけ足す（最初の1回だけ数え始めの時刻から全部）。読めない時は null（＝Claude のまま）
import type { SupabaseClient } from "@supabase/supabase-js";
import { claudeUsageUsd, altUsageUsd } from "./llm-price";
import { readBudgetConfig, spendWindowStart, claudeMonthSpendUsd, budgetDecision, type BudgetDecision } from "./llm-budget-route";

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

export async function monthSums(sb: SupabaseClient, nowMs = Date.now(), env: Record<string, string | undefined> = process.env): Promise<Sums | null> {
  const cfg = readBudgetConfig(env);
  const { since } = spendWindowStart(cfg, nowMs);
  if (cache && cache.since === since && nowMs - cache.readAt < BUDGET_CACHE_MS) return cache;
  const next: Sums = cache && cache.since === since ? { ...cache } : { since, lastId: 0, claudeUsd: 0, openaiUsd: 0, deepseekUsd: 0, readAt: 0 };
  try {
    for (let page = 0; page < 50; page++) {
      let q = sb.from("llm_usage_logs").select(COLS).gte("created_at", since).order("id", { ascending: true }).limit(1000);
      if (next.lastId) q = q.gt("id", next.lastId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Row[];
      for (const r of rows) { addRow(next, r); next.lastId = Math.max(next.lastId, Number(r.id)); }
      if (rows.length < 1000) break;
    }
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
export async function budgetDecisionFor(sb: SupabaseClient, routeName: string | null, nowMs = Date.now(), env: Record<string, string | undefined> = process.env): Promise<BudgetDecision> {
  const cfg = readBudgetConfig(env);
  if (cfg.mode === "off" || cfg.switchAtUsd == null) return budgetDecision(routeName, null, cfg);
  return budgetDecision(routeName, await claudeSpendNow(sb, nowMs, env), cfg);
}

export function resetBudgetCache(): void { cache = null; }
