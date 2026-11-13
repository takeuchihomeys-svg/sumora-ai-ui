// 実行: npx tsx app/lib/__tests__/exam-runs.test.ts
// 2026-11-13 竹内さん「試験の統括と拡張ツールとデータベースの連携の部分をちゃんとできるようにする。
//   より強化できるようにする」
//
// 「試験の統括」（exam-conductor）の結果は**手元のファイルだけ**で、DBに残っていなかった（＝連携できていなかった）。
// ここで、結果をDBに残す形（exam_runs）と、傾向を数える所を固定する。
import { toExamRun, toExamRunFromConductor, summarizeExamRuns, type ExamRunRow } from "../exam-runs";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}

console.log("■ ① 結果 → DBの1行（点・件数・理由だけ）");
{
  const local = {
    label: "2026-11-13-r1", at: "2026-11-13T07:00:00.000Z", planLabel: "plan-1",
    compare: { pass: 18, total: 20, score: 0.9 },
    next: [{ id: "q-1", why: "場所の言い直しを外した" }, { id: "q-2", why: "徒歩を読み違え" }],
    triage: { kinds: [] },
    llm: { calls: 4, usd: 0.0123 },
  };
  const row = toExamRun(local, { candidates: 20, material: { cls: "full", files: 6, kbIds: ["kb1", "kb2"] } });
  t("label が入る", row?.label === "2026-11-13-r1");
  t("計画の label が入る", row?.plan_label === "plan-1");
  t("問題の数が入る", row?.candidates === 20);
  t("材料の数が入る", row?.material_files === 6 && row?.material_cls === "full");
  t("kb の id が入る", Array.isArray(row?.material_kb_ids) && row?.material_kb_ids?.length === 2);
  t("LLM の回数と費用が入る", row?.llm_calls === 4 && row?.cost_usd === 0.0123);
  t("人が読む1行（合格18/20・点0.9・次2件・$0.0123）", row?.summary === "合格 18/20・点 0.9・次に直す 2件・LLM 4回・$0.0123", row?.summary);
  t("次の重点（id と理由）が入る", Array.isArray(row?.next_actions) && (row?.next_actions as unknown[]).length === 2);
}

console.log("\n■ ② label が無い・壊れた入力は入れない");
{
  t("label が無ければ null", toExamRun({} as never) === null);
  t("label が空白なら null", toExamRun({ label: "   " } as never) === null);
  t("label だけでも作れる（点が無くても残す）", toExamRun({ label: "only" } as never)?.label === "only");
  t("壊れた compare でも落ちない", toExamRun({ label: "x", compare: "bad" } as never) !== null);
}

console.log("\n■ ③ 傾向を数える（統括の強化の材料）");
{
  const rows: ExamRunRow[] = [
    { label: "a", compare: { pass: 10, total: 20 }, next_actions: [{ id: "q-1", why: "A" }, { id: "q-2", why: "B" }], cost_usd: 0.01, llm_calls: 3 },
    { label: "b", compare: { pass: 15, total: 20 }, next_actions: [{ id: "q-1", why: "A" }], cost_usd: 0.02, llm_calls: 4 },
    { label: "c", compare: { pass: 20, total: 20 }, next_actions: [], cost_usd: 0.03, llm_calls: 5 },
  ];
  const s = summarizeExamRuns(rows);
  t("回数", s.runs === 3);
  t("合格の合計 45/60", s.pass === 45 && s.total === 60);
  t("合格率 0.75", s.pass_rate === 0.75, s.pass_rate);
  t("よく落ちる問題の1位は q-1（2回）", s.top_misses[0]?.id === "q-1" && s.top_misses[0]?.n === 2, s.top_misses);
  t("費用の合計 0.06", s.cost_total === 0.06, s.cost_total);
  t("費用の平均 0.02", s.cost_avg === 0.02, s.cost_avg);
  t("LLM の回数 12", s.llm_calls === 12);
  t("空でも落ちない", summarizeExamRuns([]).runs === 0 && summarizeExamRuns([]).pass_rate === null);
  t("壊れた行が混ざっても落ちない", summarizeExamRuns([{ label: "x" } as never, null as never].filter(Boolean) as ExamRunRow[]).runs === 1);
}

console.log("\n■ ④ 中身（会話・名前）は入れない");
{
  const row = toExamRun({
    label: "safe",
    compare: { pass: 1, total: 1 },
    next: [{ id: "q-1", why: "理由だけ" }],
    // ⚠ 余計な物を渡しても、入るのは id と理由だけ
  } as never);
  const s = JSON.stringify(row);
  t("next_actions は id と理由だけ", s.includes('"id":"q-1"') && !s.includes("会話"));
  t("compare は点の形だけ", !!row?.compare);
}

console.log("\n■ ⑤ 統括（--run）の結果を DB の1行にする");
{
  // 統括の結果の**実際の形**（`pass: "12→14"`・`usd: "$0.123"`・`missStages`）
  const raw = {
    label: "conductor-1",
    at: "2026-11-13T12:00:00.000Z",
    pass: "12→14",
    better: 3,
    worse: 1,
    usd: "$0.123",
    code: 0,
    verdict: "流し終えた",
    missStages: [{ id: "q015", stage: "brain" }, { id: "q042", stage: "writer" }, { nonsense: 1 }],
    // ⚠ 余計な物（会話・名前）を混ぜても入れない
    conversation: "お客様の会話本文",
  };
  const row = toExamRunFromConductor(raw, { candidates: 20, material: { cls: "kb", files: 3, kbIds: ["kb1"] }, label: "plan-1" });
  t("null にならない", !!row);
  const cmp = (row?.compare ?? {}) as Record<string, unknown>;
  const acts = (row?.next_actions ?? []) as Array<Record<string, unknown>>;
  t("合格は『今』の14（前の12も残す）", cmp.pass === 14 && cmp.pass_before === 12, row?.compare);
  t("良くなった3・悪くなった1", cmp.better === 3 && cmp.worse === 1, row?.compare);
  t("費用 $0.123 を数として読む", row?.cost_usd === 0.123, row?.cost_usd);
  t("落ちた問題は id と段だけ（2件・壊れた1件は捨てる）", acts.length === 2, row?.next_actions);
  t("計画の候補20・材料3", row?.candidates === 20 && row?.material_files === 3, [row?.candidates, row?.material_files]);
  t("計画の label を残す", row?.plan_label === "plan-1", row?.plan_label);
  const s = JSON.stringify(row);
  t("会話の中身は入れない", !s.includes("お客様の会話本文"));
  t("人が読む1行に合格の前→今", String(row?.summary ?? "").includes("合格 12→14"), row?.summary);
  t("label が無ければ null", toExamRunFromConductor({ pass: "1→1" }) === null);
  t("壊れた入力でも落ちない", toExamRunFromConductor({ label: "x" } as never) !== null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
