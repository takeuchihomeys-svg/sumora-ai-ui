// 前だけ流れて今が流れない形を始める前に止める門（scripts/lib/exam-cost-gate.ts の baseNowGate・回さない印）の単体テスト
// 実行: npx tsx scripts/lib/__tests__/exam-base-now-gate.test.ts（全 PASS で exit 0）
// 2026-11-19 作業員H: 11/19 夜の M1118n-brain-compose-blueprint（--select=rag の選びが入口の前で止まり 290問に切り替わり、前だけ $2.13・今 0問）を形にした
import { baseNowGate, examRefusalLine, examRefusalOf, EXAM_REFUSAL_TAG } from "../exam-cost-gate";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

// ─── 11/19 の実物: 全部の問題（290問）に切り替わった・上限 $2 ───
{
  const g = baseNowGate({ capUsd: 2, spentUsd: 0, baseRuns: 290, nowProblems: 290 });
  ok("290問×上限$2 は回さない", !g.go);
  ok("理由に「前だけ流れて今が流れない」", !g.go && g.why.includes("前だけ流れて今が流れない"), JSON.stringify(g));
}
// ─── 普段の依頼（13問・前を作る13問・上限 $2）は回す ───
{
  const g = baseNowGate({ capUsd: 2, spentUsd: 0, baseRuns: 13, nowProblems: 13 });
  ok("13問×上限$2 は回す", g.go, JSON.stringify(g));
  ok("今の分を取っておく（1問1回の見込み）", g.go && Math.abs(g.reserveNowUsd - 13 * 0.03) < 1e-9, JSON.stringify(g));
}
// ─── 前が全部取り置きで作らない（baseRuns 0）・今だけ ───
{
  const g = baseNowGate({ capUsd: 2, spentUsd: 0, baseRuns: 0, nowProblems: 6 });
  ok("前を作らない回は回す", g.go);
}
// ─── 取っておく分は残りの半分まで（今が大きくても前を作れなくしない） ───
{
  const g = baseNowGate({ capUsd: 1, spentUsd: 0, baseRuns: 2, nowProblems: 30, unitUsd: 0.03 });
  ok("ぎりぎり回す（前 0.06＋今 0.9 ≤ 1）", g.go, JSON.stringify(g));
  ok("取っておく分は残りの半分まで", g.go && Math.abs(g.reserveNowUsd - 0.5) < 1e-9, JSON.stringify(g));
}
// ─── もう使った額を引く ───
{
  const g = baseNowGate({ capUsd: 2, spentUsd: 1.9, baseRuns: 4, nowProblems: 4 });
  ok("使った額を引いた残りで決める", !g.go, JSON.stringify(g));
}
// ─── 上限なし・今の問題0 ───
{
  ok("上限なしは確かめない", baseNowGate({ capUsd: null, spentUsd: 0, baseRuns: 999, nowProblems: 999 }).go);
  const z = baseNowGate({ capUsd: 2, spentUsd: 0, baseRuns: 3, nowProblems: 0 });
  ok("今の問題が0なら回さない", !z.go);
}
// ─── 回さない印（brain-exam が出し、係が読む） ───
{
  const line = examRefusalLine("--select=rag の選びが失敗（入口の前）\n全部の問題に切り替えない");
  ok("印は1行", !line.includes("\n") && line.startsWith(EXAM_REFUSAL_TAG));
  const log = `前の行\n${line}\n後の行`;
  ok("印から理由を読む", examRefusalOf(log) === "--select=rag の選びが失敗（入口の前） 全部の問題に切り替えない", String(examRefusalOf(log)));
  ok("印が無ければ null", examRefusalOf("普通の試験の出力\n合格 3/4") === null);
}

console.log(`exam-base-now-gate: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
