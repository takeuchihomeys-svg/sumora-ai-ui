// scripts/lib/exam-reach-rows.ts — 「スイッチごとに何が効くか」の1本の表を、置き場の覚えと合わせて引く（#683 と #684・2026-11-25 作業員L）
//   表（コードで決まる物）: exam-switch-reach の SWITCH_REACH（needs・mark・metaKey・fixes）
//   覚え（前の on の回から）: 作業員A の置き場 <倉庫の根>/.claude/exam-cache/learned-reach.json（LearnedReachFile・loadLearnedReach・書くのは A の build-learned-reach）
//   使う所: exam-room（#684 の余地・fixes／needs）と exam-select（#683 の回す問題の最小の組・learned）が、同じ rowOf から同じ行を引く
//   置き場に無いスイッチ・無い問題は unknown（分からない＝絞らない）。置き場が無い・壊れている時も全部 unknown
import { join } from "node:path";
import { reachRowOf, SWITCH_REACH, type ReachRowOf, type SwitchReachDef } from "./exam-switch-reach";
import { loadLearnedReach, mergeLearned, type Learned, type LearnedReachFile } from "./exam-learned-reach";

export type RowOf = (sw: string) => ReachRowOf;

/** 置き場の中身から、スイッチ→（問題→覚え）を引く関数 */
export function learnedLookup(file: LearnedReachFile | null): (sw: string) => ReadonlyMap<string, Learned> | null {
  return (sw) => {
    const s = file?.switches?.[sw];
    if (!s) return null;
    return new Map(Object.entries(s.problems ?? {}).map(([id, p]) => [id, p.v]));
  };
}

/** 置き場（既定は倉庫の根の exam-cache/learned-reach.json）を1回だけ読んで、表と合わせた rowOf を作る */
export function rowOfWith(o: { file?: LearnedReachFile | null; path?: string; cacheRoot?: string; table?: Record<string, SwitchReachDef> } = {}): RowOf {
  const file = o.file !== undefined ? o.file : loadLearnedReach(o.path ?? join(o.cacheRoot ?? "", "learned-reach.json"));
  const lookup = learnedLookup(file);
  const memo = new Map<string, ReachRowOf>();
  return (sw) => {
    let r = memo.get(sw);
    if (!r) { r = reachRowOf(sw, { table: o.table ?? SWITCH_REACH, learned: lookup }); memo.set(sw, r); }
    return r;
  };
}

/** exam-select の learned に渡す形（on の全部のスイッチの覚えを合わせる: どれか hit→hit・全部 none→none・ほかは unknown） */
export function learnedForSelect(onSwitches: readonly string[], rowOf: RowOf): (id: string) => Learned {
  const ms = onSwitches.map((s) => rowOf(s).learned);
  return (id) => mergeLearned(ms, id);
}

/** exam-room・exam-select に渡す表（rowOf の行から作る＝同じ行） */
export function tableOf(onSwitches: readonly string[], rowOf: RowOf): Record<string, SwitchReachDef> {
  const t: Record<string, SwitchReachDef> = {};
  for (const s of onSwitches) { const r = rowOf(s); if (r.inTable) { const { sw: _sw, inTable: _in, learned: _l, ...def } = r; t[s] = def; } }
  return t;
}
