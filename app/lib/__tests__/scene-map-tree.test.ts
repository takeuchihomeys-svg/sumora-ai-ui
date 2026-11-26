// app/lib/__tests__/scene-map-tree.test.ts — 大きな地図の木（2026-11-27 作業員A・#804）
//   実行: npx tsx app/lib/__tests__/scene-map-tree.test.ts
import { buildSceneTree, readWithBackoff, treeStats, returnPaths, deadEnds, topGoalAct, type TreeEvent } from "../scene-map-tree";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const E = (o: Partial<TreeEvent>): TreeEvent => ({ station: "proposing", sub: null, reply: "質問", act: "reply:answer", advanced: false, reached: false, ...o });
const evs = [...Array(10)].map((_, i) => E({ reached: i < 4, act: i < 4 ? "reply:invite_viewing" : "reply:answer" })).concat([E({ station: "pickup", reply: "返事なし", act: null }), E({ station: "pickup", reply: "その他", act: "reply:promise", advanced: true })]);
const tree = buildSceneTree(evs);
t("節: 駅・状態・お客様の次・一手の4段・n と申込まで行った数", tree.get("proposing")?.n === 10 && tree.get("proposing")?.reached === 4 && tree.get("proposing > （状態なし） > 質問 > reply:invite_viewing")?.n === 4);
t("ゴールへ一番多くつながった一手", topGoalAct(tree.get("proposing")!) === "reply:invite_viewing");
t("n が少ない節は1段上に戻して読む", readWithBackoff(tree, ["proposing", "（状態なし）", "質問", "reply:invite_viewing"])?.key === "proposing > （状態なし） > 質問" && readWithBackoff(tree, ["inquiry"]) === null);
const rp = returnPaths(evs);
t("戻る道: 離れる分かれ道で竹内さんの一手と戻せた数", rp.some((r) => r.reply === "その他" && r.back === 1 && r.acts[0].act === "reply:promise"));
const de = deadEnds(tree);
t("行き止まり: n が少なく分からない節（pickup・2段目まで）", de.unknown.some((x) => x.startsWith("pickup")) && de.noGoal.length === 0);
t("数: 節と n≥10 の割合", treeStats(tree).nodes === tree.size && treeStats(tree).dense >= 1);
console.log(`scene-map-tree: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
