// npx tsx scripts/lib/__tests__/exam-problem-rag.test.ts
// 2026-11-27 作業員L（試験の問題を RAG で選ぶ・統括役の頼み）
import assert from "node:assert/strict";
import { maskForEmbedding } from "../../../app/lib/pii-mask";
import { centerVecs, centroidOf, commentsNearSwitch, cosine, ragCandidates, ragEvalOf, ragMissOf, ragQueryModeOf, reachedIdsOf, sceneShapeText, snapshotMaterialsOf, EXAM_PROBLEM_RAG_MODE, SWITCH_SCENE_WORDS } from "../exam-problem-rag";

// ① 場面の形: スタッフの実際の文は入れない・電話番号は伏せる・0行の材料は書かない
const p = { id: "q1", type: "出し切り", sub: "other:その他", hourJst: 19, customer: "電話は 090-1234-5678 です", staffText: "かしこまりました！！", context: [{ s: "staff", t: "ピックアップしました", aix: true }, { s: "customer", t: "ありがとう" }], accept: ["返信"], mustNot: ["AIX:物件"], ledger: { aix_usage_logs: [{}, {}], sent_facts: [] }, pc: null, prodBrain: { action: "property_send", mode: "aix" } };
const t = sceneShapeText(p, maskForEmbedding);
assert.ok(t.includes("場面: 出し切り / other:その他"));
assert.ok(!t.includes("090-1234-5678"), "電話番号は伏せる");
assert.ok(!t.includes("かしこまりました"), "スタッフの実際の文（正解の言い回し）は入れない");
assert.ok(t.includes("写しの材料: aix_usage_logs:2") && !t.includes("sent_facts"), "0行の材料は書かない");
assert.ok(t.includes("スタッフ(AIX): ピックアップしました") && t.includes("客: ありがとう"));
assert.deepEqual(snapshotMaterialsOf(null), []);

// ② コメント: 続いた塊だけ・他のスイッチの名前が出る塊は捨てる
const src = ["const a = 1;", "// 物件を送った後の番に、選んだ理由を1行で渡す部品の説明です", "if (stageOn(\"PICKUP_WHY_TO_BRAIN\")) {}", "// 連鎖の見立て CHAIN_INSIGHT_LINE の説明がここにあります長い", "if (stageOn(\"PICKUP_WHY_TO_BRAIN\")) {}"].join("\n");
assert.deepEqual(commentsNearSwitch(src, "PICKUP_WHY_TO_BRAIN", 6, 3, ["CHAIN_INSIGHT_LINE", "PICKUP_WHY_TO_BRAIN"]), ["物件を送った後の番に、選んだ理由を1行で渡す部品の説明です"]);

// ③ 平均を引く: どれにも似た問題（hub）が上位を占めない
assert.equal(Math.round(cosine([1, 0], [1, 0]) * 100), 100);
const vecs = { hub: [1, 1, 1], a: [1, 0.9, 0], b: [0, 1, 0.9], c: [0.9, 0, 1] };
const { mean, centered } = centerVecs(vecs);
assert.equal(mean.length, 3);
const cen = ragCandidates([1, 0.8, 0].map((x, i) => x - mean[i]), centered, 1);
assert.equal(cen.eff[0].id, "a", "平均を引くと近い問題が勝つ");
assert.deepEqual(ragCandidates([1, 0, 0], vecs, 1, new Set(["hub", "a", "c"])).eff.map((x) => x.id), ["b"], "外す問題は飛ばす");

// 2段の引き方
assert.equal(ragQueryModeOf(2, false), "重心");
assert.equal(ragQueryModeOf(1, true), "場面の言葉");
assert.equal(ragQueryModeOf(0, false), "説明");
assert.deepEqual(centroidOf(["a", "x"], { a: [2, 4] }), [2, 4]);
assert.equal(centroidOf([], {}), null);
for (const [k, v] of Object.entries(SWITCH_SCENE_WORDS)) assert.ok(v.startsWith("場面: ") && v.includes("直前のお客様: ") && v.includes("正解: "), `${k} は問題と同じ書き方`);

// ⑤ 前の回との比べ・⑥ 手の選び
const runs = [
  { label: "x-p1", switches: ["S"], rows: [{ id: "q1", marks: { m: 3 } }, { id: "q2", marks: { m: 0 } }] },
  { label: "x-p2", switches: ["S", "T", "U", "V"], rows: [{ id: "q3", marks: { m: 1 } }] },
];
assert.deepEqual(reachedIdsOf("S", ["m"], runs), ["q1"], "同時の on が多すぎる回は数えない");
const e = ragEvalOf("S", ["m"], runs, ["q1", "q9"], () => 0.03);
assert.deepEqual(e.now, { n: 2, reached: 1, share: 0.5, usd: 0.06, usdPerReached: 0.06 });
assert.deepEqual(e.rag, { n: 2, ran: 1, reached: 1, share: 1, notRun: ["q9"] });
assert.deepEqual(e.reachedMissedByRag, []);
assert.deepEqual(ragMissOf(["q1"], ["q1", "q2"]), { hit: ["q1"], missed: ["q2"], share: 0.5 });
assert.equal(EXAM_PROBLEM_RAG_MODE({}), "shadow", "既定は記録だけ");
assert.equal(EXAM_PROBLEM_RAG_MODE({ EXAM_PROBLEM_RAG: "on" }), "on");
console.log("exam-problem-rag: ok");
