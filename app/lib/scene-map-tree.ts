// app/lib/scene-map-tree.ts — 大きな地図の木（駅 → 細かい状態 → お客様の次の通の種類 → 竹内さんの一手）とゴールへの道・戻る道・行き止まり（純関数・LLM/DB なし・台帳 #804 p0）
// 2026-11-27 作業員A（竹内さん 11/27「地図もかなり細かい大きいものを作るのが良い可能性が高い」「地図分かれ道あってもゴールできるようにちゃんと構築する」）
//   手で書かず、竹内さん本人の番（成約も失注・止まった会話も・申込以降は外した照らしの json）から数えて作る。節ごとに
//     n・進んだ（その一手の後に駅が申込へ近づいた）・申込まで行った（その会話が申込に届いた）・ゴールへ一番多くつながった竹内さんの一手
//   n が少ない節は1段上（粗い方）に戻して読む（readWithBackoff）。離れる分かれ道（お客様の次が 止まる・検討／不満／返事なし／その他）では、竹内さんの戻した一手と戻せた割合
//   行き止まり（申込への道が無い・n が少なく分からない節）は地図の土台の穴として一覧に（毎晩数え直し）
//   ブレインへの渡し方は q065 の失敗を避ける置き方（C）が決まるまで記録だけ（このファイルはブレインから呼ばれない）
export type TreeEvent = { station: string; sub: string | null; reply: string; act: string | null; advanced: boolean; reached: boolean };
export type TreeNode = { key: string; depth: number; n: number; advanced: number; reached: number; children: Record<string, number>; goalAct: Record<string, number> };
export const LEVELS = ["駅", "細かい状態", "お客様の次の通", "竹内さんの一手"] as const;
/** 申込から離れる分かれ道（お客様の次の通の種類・customer-reaction-predict の REACTION_JA の名前） */
export const AWAY_REPLIES = new Set(["止まる・検討", "不満", "返事なし", "その他"]);
const partsOf = (e: TreeEvent) => [e.station, e.sub ?? "（状態なし）", e.reply, e.act ?? "（次の一手なし）"];
/** 木を作る（純関数）: 節の鍵は段の値を " > " でつないだ物 */
export function buildSceneTree(evs: readonly TreeEvent[]): Map<string, TreeNode> {
  const m = new Map<string, TreeNode>();
  for (const e of evs) {
    const p = partsOf(e);
    for (let d = 1; d <= p.length; d++) {
      const key = p.slice(0, d).join(" > ");
      const node = m.get(key) ?? { key, depth: d, n: 0, advanced: 0, reached: 0, children: {}, goalAct: {} };
      node.n++; if (e.advanced) node.advanced++; if (e.reached) node.reached++;
      if (d < p.length) node.children[p[d]] = (node.children[p[d]] ?? 0) + 1;
      if (e.reached && e.act) node.goalAct[e.act] = (node.goalAct[e.act] ?? 0) + 1;
      m.set(key, node);
    }
  }
  return m;
}
/** n が minN に届く一番細かい節で読む（純関数） */
export function readWithBackoff(tree: Map<string, TreeNode>, path: readonly string[], minN = 10): TreeNode | null {
  for (let d = Math.min(path.length, LEVELS.length); d >= 1; d--) { const nd = tree.get(path.slice(0, d).join(" > ")); if (nd && nd.n >= minN) return nd; }
  return null;
}
export const topGoalAct = (n: TreeNode) => Object.entries(n.goalAct).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
export function treeStats(tree: Map<string, TreeNode>, minN = 10): { nodes: number; dense: number; denseShare: number; byDepth: Record<number, { nodes: number; dense: number }> } {
  const xs = [...tree.values()]; const byDepth: Record<number, { nodes: number; dense: number }> = {};
  for (const x of xs) { const o = (byDepth[x.depth] ??= { nodes: 0, dense: 0 }); o.nodes++; if (x.n >= minN) o.dense++; }
  const dense = xs.filter((x) => x.n >= minN).length;
  return { nodes: xs.length, dense, denseShare: xs.length ? Math.round((dense / xs.length) * 1000) / 10 : 0, byDepth };
}
/** 戻る道（純関数）: 離れる分かれ道ごとに、竹内さんの一手と、その後に進んだ割合（戻せた） */
export function returnPaths(evs: readonly TreeEvent[]): Array<{ reply: string; n: number; back: number; acts: Array<{ act: string; n: number; back: number }> }> {
  const by = new Map<string, TreeEvent[]>();
  for (const e of evs) if (AWAY_REPLIES.has(e.reply) && e.act) by.set(e.reply, [...(by.get(e.reply) ?? []), e]);
  return [...by].map(([reply, xs]) => {
    const a = new Map<string, { n: number; back: number }>();
    for (const x of xs) { const o = a.get(x.act!) ?? { n: 0, back: 0 }; o.n++; if (x.advanced || x.reached) o.back++; a.set(x.act!, o); }
    return { reply, n: xs.length, back: xs.filter((x) => x.advanced || x.reached).length, acts: [...a].map(([act, o]) => ({ act, ...o })).sort((p, q) => q.n - p.n) };
  }).sort((p, q) => q.n - p.n);
}
/** 行き止まり（純関数）: 申込への道が無い節（n≥minN で申込まで行った番が0）と、n が少なく分からない節（2段目まで＝駅・細かい状態） */
export function deadEnds(tree: Map<string, TreeNode>, minN = 10): { noGoal: string[]; unknown: string[] } {
  const xs = [...tree.values()].filter((x) => x.depth <= 2);
  return { noGoal: xs.filter((x) => x.n >= minN && x.reached === 0).map((x) => x.key), unknown: xs.filter((x) => x.n < minN).map((x) => `${x.key}（${x.n}）`) };
}
