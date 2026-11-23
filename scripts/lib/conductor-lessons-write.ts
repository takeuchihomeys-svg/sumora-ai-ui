// scripts/lib/conductor-lessons-write.ts — 統括の学び（conductor_lessons）に書く前の確かめ（純関数・DB も LLM も持たない）
//
// 2026-11-23 作業員L（統括役の頼み: conductor_lessons が0行の調べ）:
//   書く道が2本とも表に届いていなかった:
//   ・試験の学び（scripts/exam-lessons.ts・作業員H）… --write と CONDUCTOR_LESSONS_BUILD=on の手動の時だけ書く・どの cron／試験の係からも呼ばれていない・
//     llm_usage_logs の action=exam_lesson は0行（費用の記録を直した 5024d3421 の後に一度も流れていない）。
//     しかも主の作業ツリーの .env.local には service の鍵が無く、supabase-server は公開キーに落ちる → 表は RLS（anon・authenticated を REVOKE）で
//     書けず「書けない」の警告だけで続く（黙って0行）。
//   ・本番の学び（scripts/prod-lessons.ts・前の作業員L 11/22）… 下書きを exam-cache/prod-lessons/<日>.json に置くだけ（統括役が見て書く＝案 E）で、
//     見た後に書く台本が無かった（11/22 の16件は下書きのまま）。
//   → 見た下書きを書く台本（scripts/conductor-lessons-write.ts）。ここはその行の確かめ（表の CHECK・NOT NULL と同じ線）。
import type { LessonDraft } from "./exam-lessons";

export const LESSON_MAX = 120;
export const MISS_KINDS = ["material_missing", "scene_misread", "reply_vs_aix"] as const;
export type LessonToWrite = Omit<LessonDraft, "seed"> & { lesson: string; seed?: unknown };

/** 1行の確かめ（書けない理由の並び・空なら書ける） */
export function lessonRowProblems(r: Partial<LessonToWrite>): string[] {
  const out: string[] = [];
  const need = (k: keyof LessonToWrite) => { if (!String(r[k] ?? "").trim()) out.push(`${String(k)} が空`); };
  need("source"); need("dedupe_key"); need("expected_act"); need("lesson"); need("situation_text");
  if (r.lesson && [...r.lesson].length > LESSON_MAX) out.push(`lesson が ${LESSON_MAX} 字を超える（${[...r.lesson].length}）`);
  if (r.miss_kind != null && !(MISS_KINDS as readonly string[]).includes(r.miss_kind)) out.push(`miss_kind が表の決まりの外（${r.miss_kind}）`);
  return out;
}
/** 表に入れる形（seed は表に無い欄なので外す） */
export function lessonInsertRow(r: LessonToWrite): Record<string, unknown> {
  const { seed: _seed, ...row } = r;
  void _seed;
  return { ...row, is_current: true };
}
/** 書く鍵（service の鍵が無ければ書かない＝公開キーは RLS で黙って落ちる） */
export function lessonWriteKeyProblem(env: Record<string, string | undefined>): string | null {
  return (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim() ? null : "SUPABASE_SERVICE_ROLE_KEY が無い（公開キーでは conductor_lessons に書けない・RLS）。鍵のある .env.local で流す";
}
