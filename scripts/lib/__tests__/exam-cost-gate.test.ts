// 試験の費用の門（scripts/lib/exam-cost-gate.ts）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-cost-gate.test.ts（全 PASS で exit 0）
import { estimateExamCost, costGate, repsFor, passK, attributeBaseCost, decideStage, skippableActions, claudeCheckPlan } from "../exam-cost-gate";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// 倍でない時間（土曜 UTC 12時）と倍の時間（水曜 UTC 02時）
const OFF = "2026-11-07T12:00:00Z", PEAK = "2026-11-04T02:00:00Z";

// ─── 見込み ───
{
  const e = estimateExamCost([{ id: "q1", reps: 2 }, { id: "q2", reps: 1, needsBase: true, baseReps: 4 }], { unitUsd: 0.05, at: OFF });
  ok("見込み: 回数（依頼）", e.calls.request === 3);
  ok("見込み: 回数（前を作る側）", e.calls.base === 4);
  ok("見込み: 前の側も足す", near(e.usd.total, 0.05 * 7) && near(e.usd.base, 0.2));
  ok("見込み: 倍でない時間は同じ", near(e.usdOffPeak, e.usd.total) && !e.peakNow);
}
{
  const e = estimateExamCost([{ id: "q1", reps: 2 }], { unitUsd: 0.05, at: PEAK });
  ok("見込み: 倍の時間は2倍", e.peakNow && near(e.usd.total, 0.2) && near(e.usdOffPeak, 0.1));
}
{
  const e = estimateExamCost([{ id: "q1", reps: 2 }, { id: "q1", reps: 2 }], { unitUsd: 0.05, at: OFF });
  ok("見込み: 同じ id は1つ（点検表 13）", e.calls.request === 2);
}
{
  const e = estimateExamCost([{ id: "q1", reps: 4, replayRate: 0.75 }], { unitUsd: 0.04, at: OFF });
  ok("見込み: 録音で済む割合を引く", near(e.usd.total, 0.04 * 4 * 0.25));
  const e2 = estimateExamCost([{ id: "q1", reps: 1, usdPerRep: 0.1, replayRate: 9 }], { at: OFF });
  ok("見込み: 割合は0〜1に収める", near(e2.usd.total, 0));
}

// ─── 門 ───
{
  const items = [{ id: "q1", reps: 2 }, { id: "q2", reps: 2 }];
  const e = estimateExamCost(items, { unitUsd: 0.05, at: OFF });
  const g = costGate(items, e, { capUsd: 1 });
  ok("門: 上限の内は回す", g.go === true);
}
{
  const items = [{ id: "q1", reps: 2 }, { id: "q2", reps: 2 }];
  const e = estimateExamCost(items, { unitUsd: 0.05, at: PEAK }); // 0.4
  const g = costGate(items, e, { capUsd: 0.3 });
  ok("門: 倍の時間で夜なら収まる→夜へ", !g.go && g.action === "night", JSON.stringify(g));
  const g2 = costGate(items, e, { capUsd: 0.3, urgent: true });
  ok("門: 急ぎなら回す", g2.go === true);
}
{
  const items = [{ id: "q1", reps: 2 }, { id: "q2", reps: 2 }, { id: "q3", reps: 2 }, { id: "q9", reps: 2 }];
  const e = estimateExamCost(items, { unitUsd: 0.05, at: OFF }); // 0.4
  const g = costGate(items, e, { capUsd: 0.2, mustIds: ["q9"], unitUsd: 0.05 });
  ok("門: 超える→分ける", !g.go && g.action === "split" && (g.parts?.length ?? 0) === 2, JSON.stringify(g));
  ok("門: 回帰の必須は最初の塊", !g.go && g.action === "split" && g.parts![0][0] === "q9");
}
{
  const items = [{ id: "q1", reps: 10, usdPerRep: 0.1 }];
  const e = estimateExamCost(items, { at: OFF });
  const g = costGate(items, e, { capUsd: 0.5 });
  ok("門: 1問で超える→止める", !g.go && g.action === "stop");
}

// ─── 回数 ───
ok("回数: 観測が足りない→k", repsFor([true], { k: 3 }) === 3);
ok("回数: 安定→1", repsFor([true, true, true, true], { k: 3 }) === 1);
ok("回数: 安定の外れも1（揺れない）", repsFor([false, false, false], { k: 3 }) === 1);
ok("回数: 揺れ→k", repsFor([true, false, true], { k: 4 }) === 4);
ok("回数: 回帰の必須は安定でも2", repsFor([true, true, true], { k: 3, regression: true }) === 2);

// ─── pass^k ───
{
  const a = passK([true, true, true]), b = passK([true, false, true]), c = passK([]);
  ok("pass^k: 全部通る", a.passAll && a.passAny && a.rate === 1);
  ok("pass^k: 1回外れ", !b.passAll && b.passAny && near(b.rate, 2 / 3));
  ok("pass^k: 空は通らない", !c.passAll && !c.passAny);
}

// ─── 前を作る側の費用を報告に足す ───
{
  const routes = [
    { route: "script:brain-exam-main-97fe109-7ee4d13f90-rmw2cszug", usd: 2.0, firstMs: 1000 },
    { route: "script:brain-exam-main-97fe109-7ee4d13f90-rmw2ddyxf", usd: 1.5, firstMs: 5000 },
    { route: "script:brain-exam-main-97fe109-cebe7078a3-rmw2f2ab2", usd: 0.7, firstMs: 1200 },
    { route: "script:brain-exam-off-g2", usd: 1.0, firstMs: 900 },
  ];
  const r = attributeBaseCost({ label: "off-g2", usd: 1.0, commit7: "97fe109", cfg: "7ee4d13f90", startMs: 500, endMs: 3000, baseRuns: ["main-97fe109-7ee4d13f90-rmw2cszug"] }, routes);
  ok("前の費用: 子の名前で足す", near(r.baseUsd, 2.0) && near(r.total, 3.0) && !r.estimated);
  const r2 = attributeBaseCost({ label: "off-g2", usd: 1.0, commit7: "97fe109", cfg: "7ee4d13f90", startMs: 500, endMs: 3000 }, routes);
  ok("前の費用: 名前が無い時は同じ commit・構成・時間の内（推定）", near(r2.baseUsd, 2.0) && r2.estimated && r2.runs.length === 1);
}

// ─── 段・省く名札・Claude の確かめ ───
ok("段: 判断の組は brain", decideStage({ group: "brain", diffStage: "draft" }) === "brain");
ok("段: 文の組は draft", decideStage({ group: "reply", diffStage: "brain" }) === "draft" && decideStage({ group: "aix" }) === "draft");
ok("段: 組なし・diff が brain/none → brain", decideStage({ diffStage: "brain" }) === "brain" && decideStage({ diffStage: "none" }) === "brain");
ok("段: 分からない → draft（安全側）", decideStage({}) === "draft");
ok("省く: 既定は入口の読みも省く", skippableActions().includes("conductor_intake"));
ok("省く: 入口の統括が決め始めたら省かない", !skippableActions({ intakeDecides: true }).includes("conductor_intake"));
{
  const scenes = [{ scene: "見積", problems: ["q010", "q011"], splitAgree: 0.9 }, { scene: "内覧", problems: ["q020"], splitAgree: 0.5 }];
  const a = claudeCheckPlan({ kind: "brain-text", defaultOn: true, scenes });
  ok("Claude: (a) 場面ごとに1問", a.ids.join(",") === "q010,q020", JSON.stringify(a));
  const b = claudeCheckPlan({ kind: "record-only", defaultOn: true, scenes: [{ scene: "見積", problems: ["q010"] }] });
  ok("Claude: (b) 記録だけは要らない", b.ids.length === 0);
  const c = claudeCheckPlan({ kind: "text-only", defaultOn: true, scenes, worseSure: ["q099"] });
  ok("Claude: (c) 確かな悪化＋割れの大きい場面", c.ids.sort().join(",") === "q020,q099", JSON.stringify(c));
  const d = claudeCheckPlan({ kind: "brain-text", defaultOn: false, scenes: [{ scene: "見積", problems: ["q010"] }] });
  ok("Claude: 既定 off のままは要らない", d.ids.length === 0);
  const e = claudeCheckPlan({ kind: "brain-text", defaultOn: true, scenes: Array.from({ length: 30 }, (_, i) => ({ scene: `s${i}`, problems: [`q${i}`] })) });
  ok("Claude: 上限20で切る", e.ids.length === 20 && /上限/.test(e.why));
}

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
