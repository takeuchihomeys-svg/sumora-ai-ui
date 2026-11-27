// scripts/lib/__tests__/scene-tree-nightly.test.ts — 地図の木の毎晩の数え直し（#687・2026-11-27 作業員A）
//   実行: npx tsx scripts/lib/__tests__/scene-tree-nightly.test.ts
import { mapActsOf, scoreNodes, summarizeTree, weakestNode, causeGuess, nightLines, weakestLedgerRow, type TreeJson } from "../scene-tree-nightly";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const N = (key: string, n: number, extra: Partial<{ advanced: number; reached: number; children: Record<string, number> }> = {}) =>
  ({ key, depth: key.split(" > ").length, n, advanced: extra.advanced ?? 0, reached: extra.reached ?? 0, children: extra.children ?? {}, goalAct: {} });

t("地図の次の一手: ヒアリングは 物件ピックアップした と約束の返信", mapActsOf("hearing").includes("aix:property_send") && mapActsOf("hearing").includes("reply:promise"));
t("分かれ道（分:<id>）も読む・知らない駅は空", mapActsOf("分:screening_concern").length > 0 && mapActsOf("unknown_station").length === 0);

// 小さな木: hearing（n 12）の一手 = 約束 8・内覧の誘い 2・一手なし 2
const tree: TreeJson = {
  nodes: [
    N("hearing", 12, { advanced: 6, children: { "（状態なし）": 3, apply_screening_worry: 9 } }),
    N("hearing > apply_screening_worry", 9),
    N("hearing > apply_screening_worry > お礼・了承", 9),
    N("hearing > apply_screening_worry > お礼・了承 > reply:promise", 7),
    N("hearing > apply_screening_worry > お礼・了承 > reply:invite_viewing", 2),
    N("hearing > （状態なし） > 質問 > reply:promise", 1),
    N("hearing > （状態なし） > 質問 > （次の一手なし）", 2),
  ],
  returns: [{ reply: "返事なし", n: 4, back: 1 }, { reply: "その他", n: 6, back: 3 }],
  deadEnds: { noGoal: ["x"], unknown: ["a（1）", "b（2）"] },
};
const sc = scoreNodes(tree);
const h = sc.find((s) => s.key === "hearing")!;
t("一致: 一手なしは数えない・地図と同じ一手の割合（8/10）", h.acts === 10 && h.agree === 8 && h.agreePct === 80);
t("近づいた割合・状態なしの割合", h.advancePct === 50 && h.noSubShare === 25);
const s = summarizeTree(tree);
t("まとめ: 行き止まり・戻る道（4/10）", s.deadNoGoal.length === 1 && s.deadUnknown === 2 && s.returnN === 10 && s.returnBack === 4 && s.returnPct === 40);

// 一番弱い節: 前の晩より下がった物が先
const prevTree: TreeJson = { ...tree, nodes: tree.nodes.map((x) => (x.key === "hearing > apply_screening_worry > お礼・了承 > reply:invite_viewing" ? { ...x, n: 0 } : x)) };
const w1 = weakestNode(s, summarizeTree({ ...prevTree, nodes: [...prevTree.nodes] }), 9, 5);
t("前の晩より下がった節を先に選ぶ", w1?.reason === "下がった" && (w1?.prevPct ?? 0) > (w1?.agreePct ?? 0));
const w2 = weakestNode(s, null, 9);
t("前の晩が無ければ n≥minN で一致が一番低い節", w2?.reason === "一番低い" && w2.key === "hearing > apply_screening_worry");
t("n≥minN の節が無ければ null", weakestNode(s, null, 100) === null);

// 原因の見込み
t("原因: 地図は AIX なのに竹内さんは AIX が少ない＝取り違え", causeGuess({ key: "k", depth: 1, n: 19, acts: 14, agree: 0, agreePct: 0, advancePct: 0, noSubShare: 10, aixShare: 28.6, mapKind: "aix" }).cause === "AIX と返信の取り違え");
t("原因: 状態の読めない番が半分以上＝材料が届かない", causeGuess({ key: "k", depth: 1, n: 19, acts: 14, agree: 2, agreePct: 14, advancePct: 0, noSubShare: 60, aixShare: 50, mapKind: "both" }).cause === "材料が届かない");
t("原因: ほかは場面の読み違い", causeGuess({ key: "k", depth: 2, n: 19, acts: 14, agree: 2, agreePct: 14, advancePct: 0, noSubShare: null, aixShare: 50, mapKind: "both" }).cause === "場面の読み違い");

const lines = nightLines(s, null, w2);
t("行: 一致・近づいた・行き止まり・戻る道・一番弱い節", lines.length === 5 && /戻せた 4（40%）/.test(lines[3]) && /一番弱い節: hearing > apply_screening_worry/.test(lines[4]));
t("台帳の行: 題で重ねる・持ち主つき・見込みの原因", (() => { const r = weakestLedgerRow(w2!); return r.title === "地図の弱い節: hearing > apply_screening_worry" && r.owner === "作業員A" && /見込み/.test(r.next); })());
console.log(`scene-tree-nightly: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
