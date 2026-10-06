// app/lib/hook-lean-server.ts（サーバー専用・画面から import しない）
// 刺さった新着1件から学んだ特徴の表（週の学び scoring_learning_runs.hook_learning）を、判定（judgeProperty の opts.hookLean）に渡す口。
//
// 2026-10-06 竹内さん「学んだ物は採点につける」:
//   ・使うのは週の学び（/api/cron/scoring-learning → hooked-arrival-learning-server.runHookLearning）で関門を通った表（kept）だけ
//     ＝ proposeUse が true（スタッフの選択との一致が全体・材料ごとのどれも下がらず、相対順位が minGain 以上良くなった）
//   ・加点だけ（HOOK_LEAN_* +5・2つまで）・保留・外す候補には付けない（property-brain.judgeProperty）
//   ・スイッチ: 環境変数 HOOK_LEAN_MODE=off で止める（既定 on。表が無い・関門を通らない時は on でも何も付かない）
//   2026-10-06 の当て直しでは学べる物 0（scripts/audit-hooked-arrival-learning.ts）＝今は何も付かない。学びが関門を通った週から自動で効く
import type { SupabaseClient } from "@supabase/supabase-js";
import { hookCustomerTypeOf } from "./hooked-arrival-learning";
import type { HookLeanJudgeInput, HookLeanTable, HookFeatureKey } from "./hook-lean-core";
import { HOOK_FEATURE_KEYS } from "./hook-lean-core";
import type { CustomerWantInput } from "./recommendation-gaps";

export type HookLeanMode = "on" | "off";
export function hookLeanMode(raw: unknown = process.env.HOOK_LEAN_MODE): HookLeanMode {
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "off" || s === "0" || s === "false" || s === "legacy" ? "off" : "on";
}

/** 週の記録の hook_learning から使ってよい表（proposeUse・kept が空でない・知らない特徴は捨てる）。純関数 */
export function activeHookLeanTable(hookLearning: unknown): HookLeanTable | null {
  const h = hookLearning as { ok?: boolean; proposeUse?: boolean; kept?: Record<string, unknown> } | null | undefined;
  if (!h || h.ok === false || h.proposeUse !== true || !h.kept || typeof h.kept !== "object") return null;
  const known = new Set<string>(HOOK_FEATURE_KEYS);
  const t: HookLeanTable = {};
  for (const [type, fs] of Object.entries(h.kept)) {
    if (!Array.isArray(fs)) continue;
    const ok = fs.filter((f): f is HookFeatureKey => typeof f === "string" && known.has(f));
    if (ok.length) t[type] = [...new Set(ok)];
  }
  return Object.keys(t).length ? t : null;
}

let cache: { at: number; table: HookLeanTable | null; runId: number | null } | null = null;
const CACHE_MS = 10 * 60_000;

/** 一番新しい本番の週の学び（dry でない）の表。10分は読み直さない。読めない時は null（何も付けない） */
export async function loadActiveHookLeanTable(sb: SupabaseClient): Promise<{ table: HookLeanTable | null; runId: number | null }> {
  if (cache && Date.now() - cache.at < CACHE_MS) return { table: cache.table, runId: cache.runId };
  let table: HookLeanTable | null = null, runId: number | null = null;
  try {
    const { data, error } = await sb.from("scoring_learning_runs").select("id, hook_learning").eq("dry", false).not("hook_learning", "is", null).order("id", { ascending: false }).limit(1).maybeSingle();
    if (!error && data) { runId = Number((data as { id: number }).id); table = activeHookLeanTable((data as { hook_learning: unknown }).hook_learning); }
  } catch { table = null; }
  cache = { at: Date.now(), table, runId };
  return { table, runId };
}

/**
 * 判定に渡す材料（表＋このお客様の型）。止めている・表が無い・条件が無い時は null。
 *   customer は property_customers の行（条件欄）。judge API と売上サポの recordPickupBatch が judgeProperty の前に呼ぶ
 */
export async function hookLeanForJudge(sb: SupabaseClient, customer: CustomerWantInput["conditions"] | null | undefined): Promise<HookLeanJudgeInput | null> {
  if (hookLeanMode() === "off" || !customer) return null;
  const { table } = await loadActiveHookLeanTable(sb);
  if (!table) return null;
  return { table, type: hookCustomerTypeOf(customer) };
}
