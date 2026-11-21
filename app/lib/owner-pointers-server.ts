// app/lib/owner-pointers-server.ts — 竹内さんの指摘の帳面（owner_pointers）を読む・書く（サーバーの鍵だけ・LLM なし）
//
// 2026-11-21 作業員N（台帳 #472・統括役の頼み）。試験の係（作業員H・#463）との受け口は H と決めた形（11/21）:
//   pointersForExam … 夜の1本を組む所で1回。state=fixing かつ exam_qids がある行の qids を優先の枠に入れる
//   recordPointerExam … 夜の全部の部が終わった後に1回（label の一覧）。その行の exam_qids が全部 compared に入り、どれも worseSure に無い時だけ exam_passed へ。
//                        揺れ（flaky）だけの時は進めず events に残す。二分の子（-bA/-bB）の結果は呼ぶ側で外して渡す
import type { SupabaseClient } from "@supabase/supabase-js";
import { canAdvance, type PointerState } from "./owner-pointers";

export type PointerExamRow = { id: number; kinds: string[]; exam_qids: string[]; said_at: string };

export async function pointersForExam(sb: SupabaseClient, limit = 50): Promise<PointerExamRow[]> {
  const { data, error } = await sb.from("owner_pointers").select("id,kinds,exam_qids,said_at").eq("state", "fixing").neq("exam_qids", "{}").order("said_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`owner_pointers: ${error.message}`);
  return (data ?? []) as PointerExamRow[];
}

/** 1行の判定（純関数）: 全部比べた・確かな悪化なし→進める／揺れがある→残すだけ／比べていない qid がある→待つ */
export function pointerExamVerdict(qids: ReadonlyArray<string>, r: { compared: ReadonlyArray<string>; worseSure: ReadonlyArray<string>; flaky: ReadonlyArray<string> }): "advance" | "worse" | "flaky" | "incomplete" {
  if (!qids.length) return "incomplete";
  if (qids.some((q) => r.worseSure.includes(q))) return "worse";
  if (!qids.every((q) => r.compared.includes(q))) return "incomplete";
  if (qids.some((q) => r.flaky.includes(q))) return "flaky";
  return "advance";
}

export async function recordPointerExam(sb: SupabaseClient, o: { pointerIds: number[]; labels: string[]; compared: string[]; worseSure: string[]; flaky: string[]; actor?: string }): Promise<Array<{ id: number; verdict: string }>> {
  if (!o.pointerIds.length) return [];
  const { data, error } = await sb.from("owner_pointers").select("id,state,exam_qids").in("id", o.pointerIds);
  if (error) throw new Error(`owner_pointers: ${error.message}`);
  const out: Array<{ id: number; verdict: string }> = [];
  for (const p of (data ?? []) as Array<{ id: number; state: PointerState; exam_qids: string[] }>) {
    const v = pointerExamVerdict(p.exam_qids ?? [], o);
    const to: PointerState | null = v === "advance" && canAdvance(p.state, "exam_passed") ? "exam_passed" : null;
    if (to) await sb.from("owner_pointers").update({ state: to, updated_at: new Date().toISOString() }).eq("id", p.id);
    await sb.from("owner_pointer_events").insert({ pointer_id: p.id, kind: "exam", from_state: p.state, to_state: to, actor: o.actor ?? "exam-conductor",
      detail: { labels: o.labels, verdict: v, qids: p.exam_qids, worse: (p.exam_qids ?? []).filter((q) => o.worseSure.includes(q)), flaky: (p.exam_qids ?? []).filter((q) => o.flaky.includes(q)) } });
    out.push({ id: p.id, verdict: v });
  }
  return out;
}
