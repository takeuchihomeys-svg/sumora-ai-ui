// 2026-09-13 最終チェックに渡す会社ルールを「永久・線引き → 禁止 → その他 → 足せ型」の順に上限の中で選ぶ
// 実行: npx tsx app/lib/__tests__/final-check-rules.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { selectRulesForCheck, classifyCheckRule } from "../final-check-rules";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

// fetchPromptRules と同じ形の文字列
const build = (perm: string[], learned: string[]) =>
  "\n\n" + [
    perm.length ? `【永久ルール（最上位・絶対厳守）】\n${perm.map((r) => `・${r}`).join("\n")}` : "",
    learned.length ? `【AI学習ルール（参考）】\n${learned.map((r) => `・${r}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

const PERM = "お客様を急かす表現は使わない。";
const BOUNDARY = "【線引き】# 入居時期の線引き\n\n## ❌ NG：\n- 入居可能日を告げる";
const STYLE_NEW = "NG:感謝の返信に承認のみで終える。OK:承認の後にサポート姿勢を加える。";   // 足せ型（新しい）
const OTHER_NEW = "お客様が😭など喜びを表した直後は親密感のある言い回しにする。";            // その他
const PROHIBIT_OLD = "特定物件の保証会社費用を聞かれた場合、AIは金額を一切生成・推測してはいけない。"; // 禁止（古い＝後ろ）

it("分類: 永久・線引き=core／足せ型=additive／禁止=prohibit／それ以外=other", () => {
  expect(classifyCheckRule(PERM, true)).toBe("core");
  expect(classifyCheckRule(BOUNDARY, false)).toBe("core");
  expect(classifyCheckRule(STYLE_NEW, false)).toBe("additive");
  expect(classifyCheckRule(PROHIBIT_OLD, false)).toBe("prohibit");
  expect(classifyCheckRule(OTHER_NEW, false)).toBe("other");
});

it("上限に余裕があれば全部入る（何も落とさない）", () => {
  const s = selectRulesForCheck(build([PERM], [BOUNDARY, STYLE_NEW, OTHER_NEW, PROHIBIT_OLD]), 10000);
  expect(s.kept.core + s.kept.prohibit + s.kept.other + s.kept.additive).toBe(5);
  expect(s.dropped.additive + s.dropped.other + s.dropped.prohibit).toBe(0);
});

it("上限が足りない時: 後ろにある古い禁止ルールが、前にある足せ型より先に残る", () => {
  const src = build([PERM], [BOUNDARY, STYLE_NEW, OTHER_NEW, PROHIBIT_OLD]);
  // 永久＋線引き＋禁止1件がちょうど入る上限
  const budget = "【永久ルール（最上位・絶対厳守）】".length + "【AI学習ルール（参考）】".length + 4 + PERM.length + 2 + BOUNDARY.length + 2 + PROHIBIT_OLD.length + 2;
  const s = selectRulesForCheck(src, budget);
  expect(s.text.includes(PROHIBIT_OLD)).toBe(true);
  expect(s.text.includes(STYLE_NEW)).toBe(false);
  expect(s.dropped.other).toBe(1);
  expect(s.dropped.additive).toBe(1);
});

it("ルールの途中で切らない・改行を含む【線引き】も1件のまま残る", () => {
  const s = selectRulesForCheck(build([PERM], [BOUNDARY, PROHIBIT_OLD]), 10000);
  expect(s.text.includes(BOUNDARY)).toBe(true);
  expect(s.text.split("\n・").length - 1 + (s.text.startsWith("・") ? 1 : 0)).toBe(3);
});

it("永久ルール・線引きだけで上限を超えても全部入れる（上限より優先）", () => {
  const s = selectRulesForCheck(build([PERM], [BOUNDARY, PROHIBIT_OLD]), 10);
  expect(s.coreOverBudget).toBe(true);
  expect(s.text.includes(PERM) && s.text.includes(BOUNDARY)).toBe(true);
  expect(s.dropped.prohibit).toBe(1);
});

it("学習ルールの中の並び: 線引き → 禁止 → その他 → 足せ型", () => {
  const s = selectRulesForCheck(build([], [STYLE_NEW, OTHER_NEW, PROHIBIT_OLD, BOUNDARY]), 10000);
  const pos = [BOUNDARY, PROHIBIT_OLD, OTHER_NEW, STYLE_NEW].map((r) => s.text.indexOf(r));
  expect(pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1]))).toBe(true);
});

it("形式が読めない文字列（DB 障害の警告など）は従来どおり先頭から上限で切る", () => {
  const warn = "\n\n【重要: ルールDBへの接続に失敗しました。基本的な敬語を守って回答してください。】";
  expect(selectRulesForCheck(warn, 20).text).toBe(warn.slice(0, 20));
  expect(selectRulesForCheck("", 20).text).toBe("");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
