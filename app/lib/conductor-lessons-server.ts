// app/lib/conductor-lessons-server.ts — 統括が近い場面の学びを読む（サーバー専用・DB の読み1回＋埋め込み1回）
//
// 2026-11-21 作業員L（KB 56691196・統括役の決め: 既定 shadow＝記録だけ）。表と RPC は作業員H（conductor_lessons・match_conductor_lessons）。
//   問いの文は学びを作った時と同じ形（conductor-turn-vectors.turnSituationText・場面は入口の時点では無いので null）。
//   漏れの線: 今の会話（conversation_id）と、試験の時は問題の元の会話（BRAIN_JUDGE_EXAMPLES_EXCLUDE_CONV・brain-exam が問題ごとに入れる）を p_exclude_convs で外す。
//   読み終わった後も pickLessons が source_conv・"prod:<頭8字>" で同じ会話の学びを外す（二重の線）。
//   失敗・時間切れは空（今まで通り）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { pickLessons, excludeSourcesFor, LESSONS_TOP, lessonsMinRows, type LessonRow } from "./conductor-lessons";
import { turnSituationText } from "./conductor-turn-vectors";

export const LESSONS_TIMEOUT_MS = 1_500;

export function lessonsExcludeConvs(conversationId: string | null | undefined, env: Record<string, string | undefined> = process.env): string[] {
  const ex = (env.BRAIN_JUDGE_EXAMPLES_EXCLUDE_CONV ?? "").trim();
  return [...new Set([String(conversationId ?? "").trim(), ex].filter(Boolean))];
}

// 2026-11-21 統括役の注意: 入口の統括の carryLine は順に待つ（直列）ので、学びの行が0件の間は埋め込みも RPC も呼ばない。
//   現行の行の数は 60秒取り置く（数えは head の count 1回・索引 conductor_lessons_scene_idx の部分索引の上）
const COUNT_TTL_MS = 60_000;
let countMemo: { at: number; n: number } | null = null;
export async function currentLessonCount(sb: SupabaseClient, nowMs = Date.now()): Promise<number> {
  if (countMemo && nowMs - countMemo.at < COUNT_TTL_MS) return countMemo.n;
  const { count, error } = await sb.from("conductor_lessons").select("id", { count: "exact", head: true }).eq("is_current", true);
  const n = error ? 0 : (count ?? 0);
  countMemo = { at: nowMs, n };
  return n;
}
/** テスト用: 取り置きを捨てる */
export function resetLessonCountMemo(): void { countMemo = null; }

export async function loadConductorLessons(sb: SupabaseClient, o: { conversationId: string; customerTurn: string; stage?: string | null }): Promise<LessonRow[]> {
  // 2026-11-23 作業員L（統括役の決め C）: 行が少ない間（本番 10 未満・試験は 1 から）は読まない
  if ((await currentLessonCount(sb)) < lessonsMinRows()) return [];
  const text = turnSituationText({ scene: null, stage: o.stage ?? null, customerMasked: String(o.customerTurn ?? ""), lastStaffKind: null });
  const { embedTexts } = await import("./design-knowledge-rag-server");
  const t0 = Date.now();
  const e = await embedTexts([text]);
  const emb = e.vectors[0];
  // 2026-11-23 作業員L（統括役の決め）: 埋め込みの費用を llm_usage_logs に残す（action=conductor_lesson_embed・今までは残っていなかった）
  try {
    const { recordAltUsage } = await import("./llm-usage-recorder");
    recordAltUsage({ model: "text-embedding-3-small", action: "conductor_lesson_embed", conversationId: o.conversationId || null,
      usage: { input_tokens: e.tokens, output_tokens: 0, cache_read_input_tokens: 0 }, status: emb ? 200 : 0, errorType: emb ? null : "no_vector",
      durationMs: Date.now() - t0, sysHead: "【統括の学びの埋め込み】conductor-lessons", sysKeyFull: null, maxTokens: null });
  } catch { /* 記録の失敗で読みを止めない */ }
  if (!emb) return [];
  const { data, error } = await sb.rpc("match_conductor_lessons", {
    query_embedding: JSON.stringify(emb), match_count: LESSONS_TOP + 3, p_scene: null, p_stage: o.stage ?? null,
    p_exclude_sources: excludeSourcesFor(o.conversationId), p_exclude_convs: lessonsExcludeConvs(o.conversationId),
  });
  if (error) throw new Error(`match_conductor_lessons: ${error.message}`);
  return pickLessons((data ?? []) as LessonRow[], o.conversationId);
}

/** 時間の上限つき（失敗・遅い時は空） */
export async function loadConductorLessonsWithin(sb: SupabaseClient, o: { conversationId: string; customerTurn: string; stage?: string | null }, ms = LESSONS_TIMEOUT_MS): Promise<LessonRow[]> {
  try {
    return await Promise.race([loadConductorLessons(sb, o), new Promise<LessonRow[]>((r) => setTimeout(() => r([]), ms))]);
  } catch (e) { console.warn("[conductor-lessons] skipped:", e instanceof Error ? e.message : String(e)); return []; }
}
