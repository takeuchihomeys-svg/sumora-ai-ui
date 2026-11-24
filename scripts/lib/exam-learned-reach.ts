// scripts/lib/exam-learned-reach.ts — 前の on の回から「スイッチが効いた問題／効かなかった問題」を自動で覚える（台帳 #683 の自動で覚える部分・純関数・LLM なし）
// 2026-11-25 夜 作業員A（竹内さん 11/24 19時半「問題の部分を限定する能力」・統括役の頼み）
//   いちばん確かな印は、試験の行の inputSame（その回の LLM の呼び出しが全部、前の main の答えの控えで済んだ＝入力が off と1字も同じ）。
//     同じ入力なら答えも判定も off と同じ＝その問題ではスイッチが効かない（悪化も改善も出ようがない）。
//   覚え方（問題ごと）:
//     none … その スイッチの on の回で、控えがあった回が全部 inputSame（効かない）
//     hit  … 控えがあって、判定以外でも入力が変わった回が1回でもある、または材料の印（material_marks の欄）が立った（効いた）
//     unknown … 控えが無い回だけ・行が無い（分からない＝残す）
//   スイッチが複数の束の回は、どのスイッチが効いたか分けられないので覚えない（呼ぶ側で1つのスイッチの回だけ渡す）
import { readFileSync } from "node:fs";
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

// ── 2026-11-25 作業員A（統括役の取り次ぎ・L と表を1本に）: 覚えた表の置き場 <倉庫の根>/.claude/exam-cache/learned-reach.json の形 ──
//   書くのは A（scripts/build-learned-reach.ts・晩の費用0の仕事）。読むのは L の exam-switch-reach.reachRowOf(sw)（loadLearnedReach を使う）
//   鍵: switches[スイッチの名前].problems[問題の id]。覚えは「その組より前の on の回」から＝置き場は今までの全部の回の覚え（試験の前に読む物）
export type LearnedProblem = { v: Learned; same: number; diff: number; mark: number; lastAt: string };
export type LearnedReachFile = {
  v: 1;
  /** 作った時刻 */ at: string;
  /** 覚えた回の期間（日） */ days: number;
  switches: Record<string, { runs: number; lastRunAt: string; problems: Record<string, LearnedProblem> }>;
};
/** 1つのスイッチの on の回の行（回ごとに時刻つき）→ 置き場の1行（learnReach と同じ決め方に数を添える） */
export function learnedSwitchRow(runs: ReadonlyArray<{ t: number; rows: readonly LearnRow[] }>, markKeys: readonly string[] = []): LearnedReachFile["switches"][string] {
  const all = runs.flatMap((r) => r.rows.map((x) => ({ ...x, _t: r.t })));
  const v = learnReach(all, markKeys);
  const problems: Record<string, LearnedProblem> = {};
  for (const id of new Set(all.map((x) => x.id))) {
    const xs = all.filter((x) => x.id === id && !x.error);
    const same = xs.filter((x) => x.inputSame === true).length;
    const diff = xs.filter((x) => x.inputSame !== true && (x.inputDiff?.pinned ?? 0) > 0 && (x.inputDiff?.changed ?? []).some((c) => c !== "判定")).length;
    const mark = xs.filter((x) => markKeys.some((k) => (x.brain?.material_marks?.[k] ?? 0) > 0)).length;
    problems[id] = { v: v.get(id) ?? "unknown", same, diff, mark, lastAt: new Date(Math.max(...xs.map((x) => x._t), 0)).toISOString() };
  }
  return { runs: runs.length, lastRunAt: new Date(Math.max(...runs.map((r) => r.t), 0)).toISOString(), problems };
}
/** 置き場を読む（無い・壊れている時は null） */
export function loadLearnedReach(file: string): LearnedReachFile | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as LearnedReachFile;
    return j && j.v === 1 && j.switches ? j : null;
  } catch { return null; }
}
