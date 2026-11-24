// scripts/lib/exam-learned-reach.ts — 前の on の回から「スイッチが効いた問題／効かなかった問題」を自動で覚える（台帳 #683 の自動で覚える部分・純関数・LLM なし）
// 2026-11-25 夜 作業員A（竹内さん 11/24 19時半「問題の部分を限定する能力」・統括役の頼み）
//   いちばん確かな印は、試験の行の inputSame（その回の LLM の呼び出しが全部、前の main の答えの控えで済んだ＝入力が off と1字も同じ）。
//     同じ入力なら答えも判定も off と同じ＝その問題ではスイッチが効かない（悪化も改善も出ようがない）。
//   覚え方（問題ごと）:
//     none … その スイッチの on の回で、控えがあった回が全部 inputSame（効かない）
//     hit  … 控えがあって、判定以外でも入力が変わった回が1回でもある、または材料の印（material_marks の欄）が立った（効いた）
//     unknown … 控えが無い回だけ・行が無い（分からない＝残す）
//   スイッチが複数の束の回は、どのスイッチが効いたか分けられないので覚えない（呼ぶ側で1つのスイッチの回だけ渡す）
export type LearnRow = { id: string; error?: unknown; inputSame?: boolean | null; inputDiff?: { calls?: number; pinned?: number; changed?: string[] } | null; brain?: { material_marks?: Record<string, number> | null } | null };
export type Learned = "none" | "hit" | "unknown";

/** 1つのスイッチの on の回の行（いくつの回でも）→ 問題ごとの覚え。markKeys はそのスイッチの印の欄（無ければ []） */
export function learnReach(rows: readonly LearnRow[], markKeys: readonly string[] = []): Map<string, Learned> {
  const agg = new Map<string, { same: number; diff: number; mark: number }>();
  for (const r of rows) {
    if (r.error) continue;
    const a = agg.get(r.id) ?? { same: 0, diff: 0, mark: 0 };
    if (markKeys.some((k) => (r.brain?.material_marks?.[k] ?? 0) > 0)) a.mark++;
    const pinned = r.inputDiff?.pinned ?? 0;
    if (r.inputSame === true) a.same++;
    else if (pinned > 0 && (r.inputDiff?.changed ?? []).some((c) => c !== "判定")) a.diff++;
    // 控えが無い回（pinned 0）・判定だけ変わった回は数えない（判定だけ変わる＝前の答えの文は同じでも判定が揺れた／分からない）
    agg.set(r.id, a);
  }
  const out = new Map<string, Learned>();
  for (const [id, a] of agg) out.set(id, a.mark || a.diff ? "hit" : a.same ? "none" : "unknown");
  return out;
}
/** 複数のスイッチの覚えを合わせる: どれか1つでも hit なら hit・全部 none なら none・それ以外は unknown */
export function mergeLearned(ms: ReadonlyArray<ReadonlyMap<string, Learned>>, id: string): Learned {
  const vs = ms.map((m) => m.get(id) ?? "unknown");
  if (!vs.length) return "unknown";
  if (vs.some((v) => v === "hit")) return "hit";
  if (vs.every((v) => v === "none")) return "none";
  return "unknown";
}
