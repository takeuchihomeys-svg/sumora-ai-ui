// app/lib/silent-since-ours.ts — こちらの連絡の後、お客様の返事が止まっている事実の1行（#805 の続き・2026-11-28 作業員A・統括役の決め）
//   ブレインの材料に置くのは事実だけ: 「最後はこちらの通・24〜48時間お客様の返事が無い・その通は約束ではない」。
//   日数ごとの戻りの割合（120日の数え）は入れない（n が少ない所の数を材料にするとブレインがそれに引っ張られる・統括役 11/28）。
//   決め直させない置き方: 何をするかは書かない（追うかどうか・何で追うかはブレインとスタッフ）。やることリストの追いの行（STAFF_TODO_SILENT_FOLLOWUP）と同じ線。
//   SILENT_SINCE_OURS_LINE（既定 off・段階で読む）・印 material_marks.silent_since_ours
import { stagedOn, STAGE_OFF } from "./switch-stage";
import { SILENT_PROMISE_BEFORE_RE, SILENT_FOLLOWUP_MIN_MS, SILENT_FOLLOWUP_MAX_MS } from "./staff-todo-list";
import { jstMDHm } from "./jst-date";

type Env = Record<string, string | undefined>;
export const silentSinceOursOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => stagedOn("SILENT_SINCE_OURS_LINE", env, STAGE_OFF);

/** msgs は新しい順（brain-core の typedMessages と同じ）。当たらなければ "" */
export function silentSinceOursLine(msgs: ReadonlyArray<{ sender: string; text: string | null; created_at: string }>, nowMs: number): string {
  const last = msgs[0];
  if (!last || last.sender === "customer") return "";
  const gap = nowMs - Date.parse(last.created_at);
  if (!(gap >= SILENT_FOLLOWUP_MIN_MS && gap < SILENT_FOLLOWUP_MAX_MS)) return "";
  if (!msgs.some((m) => m.sender === "customer")) return "";
  if (SILENT_PROMISE_BEFORE_RE.test(last.text ?? "")) return "";
  return `【こちらの連絡の後の様子（事実・材料）】最後はこちらの通（${jstMDHm(last.created_at)}）で、お客様の返事が1日ありません（その通は約束ではありません）。`;
}
