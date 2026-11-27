// scripts/lib/scene-tree-nightly.ts — #804 の大きな地図の木を毎晩数え直す（#687・純関数・LLM/DB なし・2026-11-27 作業員A）
//
// 入力: audit-scene-branches.ts --tree-out の json（{ nodes: TreeNode[]; returns; deadEnds }・節の key は「駅 > 細かい状態 > お客様の次の通 > 竹内さんの一手」）
// 数えるもの（駅＝深さ1・細かい状態＝深さ2）:
//   一致     … その節の下の竹内さんの一手のうち、地図の次の一手（apply-route-map の next.aix・約束の返信）と同じ物の割合（一手なしは数えない）
//   近づいた … その節の番のうち、申込へ近づいた（advanced）割合
//   行き止まり … 申込まで行った番が0の節（n≥minN）と、n が少なく分からない節
//   戻る道   … 離れる通（止まる・検討／不満／返事なし／その他）の後、竹内さんの一手で戻せた割合
// 前の晩との差を出し、一番弱い節を1つ選ぶ: 前の晩より一致が 10pt 以上下がった節があればそれ（一番下がった物）、無ければ n≥minN で一致が一番低い節。
//   原因の3つ（材料が届かない・場面の読み違い・AIX と返信の取り違え）のどれの見込みかを、決まった目安で付ける（言い切らない＝見込み）。
import { ROUTE_NODES, ROUTE_BRANCHES } from "../../app/lib/apply-route-map";
import type { TreeNode } from "../../app/lib/scene-map-tree";

export type TreeJson = { nodes: TreeNode[]; returns?: Array<{ reply: string; n: number; back: number }>; deadEnds?: { noGoal: string[]; unknown: string[] } };
export const NO_ACT = "（次の一手なし）";
export const NO_SUB = "（状態なし）";
export type Cause = "材料が届かない" | "場面の読み違い" | "AIX と返信の取り違え";

/** 駅（分かれ道は「分:<id>」）の地図の次の一手（"aix:<種類>"・約束の返信なら "reply:promise"） */
export function mapActsOf(station: string): string[] {
  const id = station.startsWith("分:") ? station.slice(2) : station;
  const step = (ROUTE_NODES as Record<string, { next: { label: string; aix: string[] } }>)[id]?.next ?? (ROUTE_BRANCHES as Record<string, { next: { label: string; aix: string[] } }>)[id]?.next;
  if (!step) return [];
  return [...step.aix.map((a) => `aix:${a}`), ...(/約束/.test(step.label) ? ["reply:promise"] : [])];
}
const kindOf = (act: string) => (act.startsWith("aix:") ? "aix" : act.startsWith("reply:") ? "reply" : "none");

export type NodeScore = { key: string; depth: number; n: number; acts: number; agree: number; agreePct: number | null; advancePct: number | null; noSubShare: number | null; aixShare: number | null; mapKind: "aix" | "reply" | "both" | "none" };
/** 深さ1・2の節ごとの一致・近づいた割合（葉＝深さ4の竹内さんの一手を数える） */
export function scoreNodes(tree: TreeJson): NodeScore[] {
  const leaves = tree.nodes.filter((x) => x.depth === 4);
  return tree.nodes.filter((x) => x.depth <= 2).map((nd) => {
    const station = nd.key.split(" > ")[0];
    const want = new Set(mapActsOf(station));
    const under = leaves.filter((l) => l.key.startsWith(`${nd.key} > `));
    let acts = 0, agree = 0, aix = 0;
    for (const l of under) { const act = l.key.split(" > ")[3]; if (!act || act === NO_ACT) continue; acts += l.n; if (want.has(act)) agree += l.n; if (kindOf(act) === "aix") aix += l.n; }
    const kinds = new Set([...want].map(kindOf));
    const noSub = nd.depth === 1 ? (nd.children[NO_SUB] ?? 0) : null;
    return {
      key: nd.key, depth: nd.depth, n: nd.n, acts, agree,
      agreePct: acts ? Math.round((agree / acts) * 1000) / 10 : null,
      advancePct: nd.n ? Math.round((nd.advanced / nd.n) * 1000) / 10 : null,
      noSubShare: noSub != null && nd.n ? Math.round((noSub / nd.n) * 1000) / 10 : null,
      aixShare: acts ? Math.round((aix / acts) * 1000) / 10 : null,
      mapKind: kinds.size === 2 ? "both" : kinds.has("aix") ? "aix" : kinds.has("reply") ? "reply" : "none",
    };
  });
}

export type NightSummary = { nodes: number; scored: NodeScore[]; dense: number; agreePct: number | null; advancePct: number | null; deadNoGoal: string[]; deadUnknown: number; returnN: number; returnBack: number; returnPct: number | null };
export function summarizeTree(tree: TreeJson, minN = 10): NightSummary {
  const scored = scoreNodes(tree);
  const dense = scored.filter((s) => s.n >= minN);
  const sum = (f: (s: NodeScore) => number) => dense.reduce((a, s) => a + f(s), 0);
  const acts = sum((s) => (s.depth === 1 ? s.acts : 0)), agree = sum((s) => (s.depth === 1 ? s.agree : 0));
  const st1 = scored.filter((s) => s.depth === 1);
  const n1 = st1.reduce((a, s) => a + s.n, 0), adv1 = tree.nodes.filter((x) => x.depth === 1).reduce((a, x) => a + x.advanced, 0);
  const ret = tree.returns ?? [];
  const rn = ret.reduce((a, r) => a + r.n, 0), rb = ret.reduce((a, r) => a + r.back, 0);
  return {
    nodes: tree.nodes.length, scored, dense: dense.length,
    agreePct: acts ? Math.round((agree / acts) * 1000) / 10 : null,
    advancePct: n1 ? Math.round((adv1 / n1) * 1000) / 10 : null,
    deadNoGoal: tree.deadEnds?.noGoal ?? [], deadUnknown: tree.deadEnds?.unknown?.length ?? 0,
    returnN: rn, returnBack: rb, returnPct: rn ? Math.round((rb / rn) * 1000) / 10 : null,
  };
}

/** 原因の見込み（決まった目安・言い切らない） */
export function causeGuess(s: NodeScore): { cause: Cause; why: string } {
  // 地図は返信（約束）なのに竹内さんは AIX が多い・その逆＝返信か AIX かの取り違え
  if (s.aixShare != null && ((s.mapKind === "reply" && s.aixShare >= 50) || (s.mapKind === "aix" && s.aixShare <= 30)))
    return { cause: "AIX と返信の取り違え", why: `地図の次の一手は${s.mapKind === "aix" ? " AIX" : "返信"}・竹内さんの一手の AIX の割合 ${s.aixShare}%` };
  // 駅の番の半分以上が細かい状態なし＝状態を読む材料が届いていない
  if (s.noSubShare != null && s.noSubShare >= 50) return { cause: "材料が届かない", why: `細かい状態の読めない番が ${s.noSubShare}%` };
  return { cause: "場面の読み違い", why: `一手の向きは合うが中身が違う（一致 ${s.agreePct ?? "—"}%）` };
}

export type Weakest = { key: string; n: number; agreePct: number | null; prevPct: number | null; reason: "下がった" | "一番低い"; cause: Cause; why: string };
/** 一番弱い節: 前の晩より一致が dropPt 以上下がった節（一番下がった物）＞ n≥minN で一致が一番低い節 */
export function weakestNode(cur: NightSummary, prev: NightSummary | null, minN = 10, dropPt = 10): Weakest | null {
  const pm = new Map((prev?.scored ?? []).map((s) => [s.key, s]));
  const cand = cur.scored.filter((s) => s.n >= minN && s.agreePct != null);
  const drops = cand.map((s) => ({ s, d: pm.get(s.key)?.agreePct != null ? (pm.get(s.key)!.agreePct as number) - (s.agreePct as number) : null })).filter((x) => x.d != null && x.d >= dropPt).sort((a, b) => (b.d as number) - (a.d as number));
  const pick = drops[0]?.s ?? [...cand].sort((a, b) => (a.agreePct as number) - (b.agreePct as number) || b.n - a.n)[0];
  if (!pick) return null;
  const c = causeGuess(pick);
  return { key: pick.key, n: pick.n, agreePct: pick.agreePct, prevPct: pm.get(pick.key)?.agreePct ?? null, reason: drops[0] ? "下がった" : "一番低い", ...c };
}

/** 朝の1枚・台本の行 */
export function nightLines(cur: NightSummary, prev: NightSummary | null, w: Weakest | null): string[] {
  const d = (a: number | null, b: number | null | undefined) => (a != null && b != null ? `（前の晩 ${b}%・${a - b >= 0 ? "+" : ""}${Math.round((a - b) * 10) / 10}pt）` : "");
  return [
    `### 地図の木（#804・毎晩・節 ${cur.nodes}・n≥10 ${cur.dense}）`,
    `- 駅の一致（地図の一手＝竹内さんの一手）: ${cur.agreePct ?? "—"}%${d(cur.agreePct, prev?.agreePct)}・申込へ近づいた: ${cur.advancePct ?? "—"}%${d(cur.advancePct, prev?.advancePct)}`,
    `- 行き止まり: 申込への道が無い節 ${cur.deadNoGoal.length}${prev ? `（前 ${prev.deadNoGoal.length}）` : ""}・n が少なく分からない節 ${cur.deadUnknown}${prev ? `（前 ${prev.deadUnknown}）` : ""}`,
    `- 戻る道: 離れた ${cur.returnN} 番のうち戻せた ${cur.returnBack}（${cur.returnPct ?? "—"}%）${d(cur.returnPct, prev?.returnPct)}`,
    w ? `- 一番弱い節: ${w.key}（n ${w.n}・一致 ${w.agreePct}%${w.prevPct != null ? `・前の晩 ${w.prevPct}%` : ""}・${w.reason}）→ 見込み: ${w.cause}（${w.why}）` : "- 一番弱い節: なし（n≥10 の節が無い）",
  ];
}
/** 台帳に積む行（題で重ねない・持ち主は #804 の持ち主） */
export function weakestLedgerRow(w: Weakest, owner = "作業員A"): { title: string; owner: string; next: string; area: string; priority: number } {
  return { title: `地図の弱い節: ${w.key}`, owner, area: "統括", priority: 20,
    next: `#687 毎晩の数え直し: 一致 ${w.agreePct}%（n ${w.n}${w.prevPct != null ? `・前の晩 ${w.prevPct}%` : ""}・${w.reason}）。見込み ${w.cause}（${w.why}）。この節の番を実物で読み、原因を3つで確かめてから直す` };
}
