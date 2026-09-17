// 2026-09-17 竹内（AIX キャッシュ点検）: ai_prompt_rules の整形（prompt-rules-format.ts）の回帰テスト。
//   fetchPromptRules と fetchPromptRulesSplit が同じ整形を使う（見出し・接頭辞・並びが揃わないとキャッシュの鍵が外れる）
// 実行: npx tsx app/lib/__tests__/prompt-rules-format.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { formatPromptRuleSections, promptRuleMatchesConditions, dedupePromptRules, promptRuleNotExcluded, type PromptRuleRow } from "../prompt-rules-format";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: unknown) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
  };
}
const row = (rule_key: string, rule_text: string, priority = 8, cond: [string, string] | null = null): PromptRuleRow =>
  ({ rule_key, rule_text, priority, condition_key: cond?.[0] ?? null, condition_value: cond?.[1] ?? null });

it("整形: 先頭 \\n\\n・【永久ルール】【AI学習ルール】の見出し・BOUNDARY-* は【線引き】接頭辞", () => {
  const s = formatPromptRuleSections([row("BOUNDARY-001", "線引きの文", 9), row("PERM-1", "永久の文", 10)], [row("FEEDBACK-1", "学習の文")]);
  expect(s).toBe("\n\n【永久ルール（最上位・絶対厳守）】\n・【線引き】線引きの文\n・永久の文\n\n【AI学習ルール（参考）】\n・学習の文");
});

it("整形: 片方だけ・両方空", () => {
  expect(formatPromptRuleSections([], [row("F", "学習の文")])).toBe("\n\n【AI学習ルール（参考）】\n・学習の文");
  expect(formatPromptRuleSections([row("P", "永久の文")], [])).toBe("\n\n【永久ルール（最上位・絶対厳守）】\n・永久の文");
  expect(formatPromptRuleSections([], [])).toBe("");
});

it("同じ行なら同じ文字列（global を準静的ブロックに置く前提: 並びが同じなら鍵が揃う）", () => {
  const rows = [row("A", "a"), row("B", "b"), row("C", "c")];
  expect(formatPromptRuleSections([], rows)).toBe(formatPromptRuleSections([], [...rows]));
  expect(formatPromptRuleSections([], rows) === formatPromptRuleSections([], [rows[1], rows[0], rows[2]])).toBe(false);
});

it("条件フィルタ: 条件なしは通す・未知の condition_key は警告して落とす・null は落とす・文字列比較で一致", () => {
  const warns: string[] = [];
  const w = (m: string) => warns.push(m);
  expect(promptRuleMatchesConditions(row("A", "a"), {}, w)).toBe(true);
  expect(promptRuleMatchesConditions(row("A", "a", 8, ["has_estimate", "true"]), {}, w)).toBe(false);
  expect(warns.length).toBe(1);
  expect(promptRuleMatchesConditions(row("A", "a", 8, ["has_estimate", "true"]), { has_estimate: null }, w)).toBe(false);
  expect(promptRuleMatchesConditions(row("A", "a", 8, ["has_estimate", "true"]), { has_estimate: true }, w)).toBe(true);
  expect(promptRuleMatchesConditions(row("A", "a", 8, ["has_estimate", "true"]), { has_estimate: "false" }, w)).toBe(false);
});

it("重複排除: rule_text で最初の出現を残す・seen を渡すと global にある文を action 側から落とす", () => {
  expect(dedupePromptRules([row("A", "同じ"), row("B", "同じ"), row("C", "違う")]).map((r) => r.rule_key)).toEqual(["A", "C"]);
  const seen = new Set(["global の文"]);
  expect(dedupePromptRules([row("X", "global の文"), row("Y", "action の文")], seen).map((r) => r.rule_key)).toEqual(["Y"]);
  expect(seen.has("action の文")).toBe(true);
});

it("exclude: 接頭辞・完全一致（カイナ事例: DIFF-POLICY-*・PROP-URL-REPLY-001・FEEDBACK-d6f30f25）", () => {
  const ex = { keyPrefixes: ["DIFF-POLICY-"], keys: ["PROP-URL-REPLY-001", "FEEDBACK-d6f30f25"] };
  expect(promptRuleNotExcluded(row("DIFF-POLICY-12", "x"), ex)).toBe(false);
  expect(promptRuleNotExcluded(row("PROP-URL-REPLY-001", "x"), ex)).toBe(false);
  expect(promptRuleNotExcluded(row("FEEDBACK-d6f30f25", "x"), ex)).toBe(false);
  expect(promptRuleNotExcluded(row("FEEDBACK-other", "x"), ex)).toBe(true);
  expect(promptRuleNotExcluded(row("DIFF-POLICY-12", "x"))).toBe(true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.join("\n")); process.exit(1); }
