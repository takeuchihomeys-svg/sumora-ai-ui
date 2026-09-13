// 2026-09-13 2層ブレイン: 今回の発言の層と戦略の層の組み合わせ・戦略が変わる発言・戦略のやり直し判定
// 実行: npx tsx app/lib/__tests__/brain-layers.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { mergeBrainLayers, extractStrategy, detectStrategyShift, decideStrategyRefresh, maxSignal, toFreshDigest, type BrainStrategy } from "../brain-layers";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
  };
}
const merge = (f: Record<string, unknown>, s: BrainStrategy | null) => mergeBrainLayers(f, s) as Record<string, unknown>;
const NOW = Date.parse("2026-09-13T10:00:00Z");
const strategy: BrainStrategy = {
  closing_strategy: "内覧日を確定し申込へつなげる", winning_pattern: "内覧日程を即提示させて頂く", next_steps: ["Step1: 内覧日調整", "Step2: 申込案内"],
  human_type_label: "即決型", repeated_concern: "初期費用", future_timeline: "10月中", checkpoint_stage: "viewing", purchase_signal_level: "strong",
  strategy_msg_ts: "2026-09-12T10:00:00Z", strategy_analyzed_at: "2026-09-12T10:01:00Z", strategy_count: 1, source: "consolidated",
};

it("今回の発言の層が優先: 意向・推奨 AIX・返信の方向は今回の値", () => {
  const m = merge({ action: "estimate_sheet", customer_intent: "question", reply_direction: "費用に答える", closing_strategy: "（今回の層が書いた値）" }, strategy);
  expect(m.action).toBe("estimate_sheet");
  expect(m.customer_intent).toBe("question");
  expect(m.reply_direction).toBe("費用に答える");
});
it("戦略が持つ項目（成約戦略・勝ちパターン・次の手順・タイプ）は戦略の値", () => {
  const m = merge({ closing_strategy: "（今回の層）", next_steps: ["x"] }, strategy);
  expect(m.closing_strategy).toBe("内覧日を確定し申込へつなげる");
  expect(m.next_steps).toEqual(["Step1: 内覧日調整", "Step2: 申込案内"]);
  expect(m.human_type_label).toBe("即決型");
});
it("決断の時期・フェーズは今回の発言で出たら今回、無ければ戦略", () => {
  expect(merge({ future_timeline: "来週末" }, strategy).future_timeline).toBe("来週末");
  expect(merge({ future_timeline: null }, strategy).future_timeline).toBe("10月中");
  expect(merge({ checkpoint_stage: null }, strategy).checkpoint_stage).toBe("viewing");
});
it("購買シグナルは蓄積と今回の高い方（蓄積をリセットしない・ae0b17a2）", () => {
  expect(merge({ purchase_signal_level: "soft" }, strategy).purchase_signal_level).toBe("strong");
  expect(merge({ purchase_signal_level: "peak" }, strategy).purchase_signal_level).toBe("peak");
  expect(maxSignal(null, "none")).toBe("none");
});
it("戦略が無ければ今回の層そのまま（出どころの記録は null）", () => {
  const m = merge({ action: "x", closing_strategy: "c" }, null);
  expect(m.closing_strategy).toBe("c");
  expect(m.strategy_source).toBe(null);
});
it("extractStrategy: 全項目の判断から戦略の層を取り出す（中身が無ければ null）", () => {
  const s = extractStrategy({ closing_strategy: "A", next_steps: ["1", "2", "3", "4"], analyzed_msg_ts: "2026-09-13T09:00:00Z", purchase_signal_level: "soft" }, "combined", 0, "2026-09-13T09:01:00Z");
  expect(s?.strategy_count).toBe(1);
  expect(s?.next_steps?.length).toBe(3);
  expect(s?.strategy_msg_ts).toBe("2026-09-13T09:00:00Z");
  expect(extractStrategy({ action: "x" }, "combined", 0, "t")).toBe(null);
});
it("戦略が変わる発言: 条件変更・決断・見送り・他決・フェーズ変化", () => {
  expect(detectStrategyShift({ fresh: { condition_change_type: "area_change" }, strategy, turnText: "" })).toBe("condition_change");
  expect(detectStrategyShift({ fresh: {}, strategy, turnText: "フジパレスは無しでお願いします" })).toBe("decision_or_decline");
  expect(detectStrategyShift({ fresh: {}, strategy, turnText: "他の不動産で決めました" })).toBe("decision_or_decline");
  expect(detectStrategyShift({ fresh: { checkpoint_stage: "applying" }, strategy, turnText: "" })).toBe("phase_change");
  expect(detectStrategyShift({ fresh: { checkpoint_stage: "viewing" }, strategy, turnText: "ありがとうございます！" })).toBe(null);
});
it("やり直し: 10件・戦略が変わる発言・72時間。何も無ければやり直さない", () => {
  expect(decideStrategyRefresh({ strategy, customerMsgsSinceStrategy: 3, nowMs: Date.parse("2026-09-12T12:00:00Z"), shift: null }).kind).toBe("none");
  expect(decideStrategyRefresh({ strategy, customerMsgsSinceStrategy: 10, nowMs: NOW, shift: null }).reason).toBe("msgs:10");
  expect(decideStrategyRefresh({ strategy, customerMsgsSinceStrategy: 1, nowMs: NOW, shift: "condition_change" }).reason).toBe("shift:condition_change");
  expect(decideStrategyRefresh({ strategy, customerMsgsSinceStrategy: 1, nowMs: Date.parse("2026-09-15T10:01:00Z"), shift: null }).reason).toBe("hours:72");
  expect(decideStrategyRefresh({ strategy: null, customerMsgsSinceStrategy: 20, nowMs: NOW, shift: "x" }).kind).toBe("none");
});
it("3回に1回はゼロから作り直す（前回の判断に引きずられない）", () => {
  expect(decideStrategyRefresh({ strategy: { ...strategy, strategy_count: 1 }, customerMsgsSinceStrategy: 10, nowMs: NOW, shift: null }).kind).toBe("consolidate");
  expect(decideStrategyRefresh({ strategy: { ...strategy, strategy_count: 2 }, customerMsgsSinceStrategy: 10, nowMs: NOW, shift: null }).kind).toBe("scratch");
});
it("毎回の分析の要点は短く（質問2件・各40字）", () => {
  const d = toFreshDigest({ analyzed_msg_ts: "t", customer_questions: ["a".repeat(60), "b", "c"], customer_intent: "question", action: "estimate_sheet" }, null);
  expect(d.q?.length).toBe(2);
  expect(d.q?.[0].length).toBe(40);
  expect(d.aix).toBe("estimate_sheet");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
