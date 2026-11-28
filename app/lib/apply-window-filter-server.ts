// app/lib/apply-window-filter-server.ts — 学びの材料から申込の期間（deal_outcomes の applied_at〜ended_at）の行を外す（サーバー専用・DB を1回読む）
// 2026-11-28 作業員L（統括役の決め3・申込以降を学びに使わない）: AIX の手本には検索の外（rag_excluded）の印が無い＝学びの側で期間を見て外す。
//   判定は rag-garbage.inApplyWindow（返信の手本の入口の歯止めと同じ期間）。deal_outcomes が読めない時は全部を外す側に倒す（fail-closed）
import type { SupabaseClient } from "@supabase/supabase-js";
import { inApplyWindow } from "@/app/lib/rag-garbage";

export type WindowRow = { conversation_id?: string | null; created_at?: string | null };
export async function dropApplyWindowRows<T extends WindowRow>(sb: SupabaseClient, rows: readonly T[]): Promise<{ kept: T[]; dropped: T[]; readFailed: boolean }> {
  const convIds = [...new Set(rows.map((r) => r.conversation_id).filter((c): c is string => !!c))];
  if (!convIds.length) return { kept: [...rows], dropped: [], readFailed: false };
  const { data, error } = await sb.from("deal_outcomes").select("conversation_id, applied_at, ended_at").in("conversation_id", convIds).not("applied_at", "is", null);
  if (error) return { kept: [], dropped: [...rows], readFailed: true };
  const winOf = new Map<string, Array<{ applied_at: string | null; ended_at: string | null }>>();
  for (const o of (data ?? []) as Array<{ conversation_id: string; applied_at: string | null; ended_at: string | null }>) winOf.set(o.conversation_id, [...(winOf.get(o.conversation_id) ?? []), o]);
  const kept: T[] = [], dropped: T[] = [];
  for (const r of rows) (r.conversation_id && inApplyWindow(winOf.get(r.conversation_id) ?? [], r.created_at ?? "") ? dropped : kept).push(r);
  return { kept, dropped, readFailed: false };
}
