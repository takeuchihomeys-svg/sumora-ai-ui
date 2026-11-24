// scripts/lib/exam-select.ts — 試験の統括ブレインの「回す問題の最小の組」（台帳 #683 の広げ・決まった計算・LLM なし）
// 2026-11-24 夜 作業員A（竹内さん 11/24 19時半「問題の部分を限定する能力を、テストのブレインがちゃんと持って、限定的に試験を行えれば」・統括役の頼み）
//   材料（今あるのをつなぐ）: ①スイッチの効く欄（exam-switch-reach の needs・markKey／promptAll）②前の回の写しで、その欄が有った問題（ledger.inserted）
//   ③今の off で外れている問題（値打ちの表の余地）④竹内さん本人の番で外れが多い型（#684・今は型の重みを渡すだけ＝並びに使う）⑤比べられる守り1問（off で2回以上・全部合格）
//   選ばない時は理由ごとに数える。決まらない所（効く欄が表に無い・指示文が全問に入る）は全部を残す＝絞らない（後で DeepSeek に決めさせる案の所）
import type { SwitchReachDef } from "./exam-switch-reach";
import type { OffPass } from "./exam-worth";
import { UNIT_USD } from "./exam-worth";

export type SelectWhy = "off で揺れ（落とさない）" | "材料あり" | "今の off で外れ（余地）" | "前の回が無い（材料が分からない）" | "守り（off で安定して合格）" | "効く欄が表に無い（絞らない）" | "off の答えが無い";
export type DropWhy = "材料0・off で合格（守りは1問で足りる）" | "材料0・off で揺れ（比べにならない）";
export type Selection = {
  keep: Array<{ id: string; why: SelectWhy; note?: string }>;
  drop: Array<{ id: string; why: DropWhy }>;
  dropCounts: Record<string, number>;
  usdAll: number; usdKeep: number;
  narrowed: boolean; reason: string;
};

/** 回す問題の最小の組（純関数）。ids は積む問題（効く＋守り）。weight は型の重み（高い型の守りを先に選ぶ・無ければ id 順） */
export function selectMinimal(o: {
  ids: readonly string[]; onSwitches: readonly string[];
  prior: ReadonlyMap<string, Record<string, number>>; off: ReadonlyMap<string, OffPass>;
  table: Readonly<Record<string, SwitchReachDef>>; stage: "brain" | "draft";
  weightOf?: (id: string) => number; guards?: number;
}): Selection {
  const ids = [...new Set(o.ids)];
  const cost = (n: number) => Math.round(n * 2 * UNIT_USD[o.stage] * 100) / 100;
  const all = (why: SelectWhy, reason: string): Selection => ({ keep: ids.map((id) => ({ id, why })), drop: [], dropCounts: {}, usdAll: cost(ids.length), usdKeep: cost(ids.length), narrowed: false, reason });
  if (!o.onSwitches.length) return all("効く欄が表に無い（絞らない）", "on のスイッチが無い");
  const unknown = o.onSwitches.filter((s) => !(o.table[s]?.needs?.length) || o.table[s]?.promptAll);
  if (unknown.length) return all("効く欄が表に無い（絞らない）", `効く欄が決まらないスイッチ（${unknown.join(",")}）＝全部を回す（後で DeepSeek に決めさせる所）`);
  const needs = [...new Set(o.onSwitches.flatMap((s) => o.table[s]?.needs ?? []))];
  const keep: Selection["keep"] = [], cand: string[] = [], drop: Selection["drop"] = [];
  for (const id of ids) {
    const l = o.prior.get(id), b = o.off.get(id);
    const hit = l ? needs.filter((t) => (l[t] ?? 0) > 0) : [];
    if (hit.length) { keep.push({ id, why: "材料あり", note: hit.join("・") }); continue; }
    if (!l) { keep.push({ id, why: "前の回が無い（材料が分からない）" }); continue; }
    if (!b || !b.n) { keep.push({ id, why: "off の答えが無い" }); continue; }
    if (b.pass * 2 < b.n) { keep.push({ id, why: "今の off で外れ（余地）", note: `${b.pass}/${b.n}` }); continue; }
    // 2026-11-24 夜: off で揺れている問題は落とさない（前の7晩の当てで、揺れで落とした q365・q094 に確かな悪化があった＝見落とし2）
    if (b.n >= 2 && b.pass === b.n) cand.push(id); else keep.push({ id, why: "off で揺れ（落とさない）", note: `${b.pass}/${b.n}` });
  }
  // 守り: 材料0・off で安定して合格の問題から、型の重みの高い順に guards 問（既定1）
  const g = Math.max(0, o.guards ?? 1);
  const sorted = [...cand].sort((a, z) => (o.weightOf?.(z) ?? 0) - (o.weightOf?.(a) ?? 0) || a.localeCompare(z));
  for (const id of sorted.slice(0, g)) keep.push({ id, why: "守り（off で安定して合格）" });
  for (const id of sorted.slice(g)) drop.push({ id, why: "材料0・off で合格（守りは1問で足りる）" });
  const dropCounts: Record<string, number> = {};
  for (const d of drop) dropCounts[d.why] = (dropCounts[d.why] ?? 0) + 1;
  return { keep, drop, dropCounts, usdAll: cost(ids.length), usdKeep: cost(keep.length), narrowed: drop.length > 0, reason: `効く欄 ${needs.join("・")}` };
}

/** 物差し: 選んだ組だけで回しても、全部回した時と同じ結論（確かな悪化の問題・良くなった問題が選んだ組に全部入っている）か */
export function sameConclusion(sel: Pick<Selection, "keep">, full: { worse: readonly string[]; better: readonly string[] }): { same: boolean; missedWorse: string[]; missedBetter: string[] } {
  const k = new Set(sel.keep.map((x) => x.id));
  const missedWorse = full.worse.filter((id) => !k.has(id)), missedBetter = full.better.filter((id) => !k.has(id));
  return { same: !missedWorse.length && !missedBetter.length, missedWorse, missedBetter };
}
