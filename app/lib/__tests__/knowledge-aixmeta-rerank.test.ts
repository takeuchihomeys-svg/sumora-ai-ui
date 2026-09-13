// 2026-09-13 返信生成のナレッジ検索の並べ替えに最新の AIX-META を使う（推奨 AIX の話題・質問・返信の方向）
// 実行: npx tsx app/lib/__tests__/knowledge-aixmeta-rerank.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { aixMetaKnowledgeBonus, extractMetaKeywords, AIX_TOPIC_BONUS, META_WORD_BONUS } from "../knowledge-aixmeta-rerank";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

it("推奨 AIX が見積書送る → 見積・初期費用のナレッジに加点", () => {
  expect(aixMetaKnowledgeBonus("初期費用の伝え方", "最大限割引した初期費用の御見積書を…", { action: "estimate_sheet", words: [] })).toBe(AIX_TOPIC_BONUS);
});
it("推奨 AIX と関係ないナレッジには加点しない", () => {
  expect(aixMetaKnowledgeBonus("内覧の誘い方", "ご都合よろしいお日にちにご案内", { action: "estimate_sheet", words: [] })).toBe(0);
});
it("お客様の質問の語を含むナレッジに加点（推奨 AIX と両方なら合計）", () => {
  const words = extractMetaKeywords(["駐車場は空いていますか", "駐車場の空きを管理会社に確認して伝える"]);
  expect(aixMetaKnowledgeBonus(null, "駐車場の空き状況は管理会社に確認", { action: "property_check_result", words })).toBe(AIX_TOPIC_BONUS + META_WORD_BONUS);
});
it("判断が無い（古い判断は呼び出し側で null にする）→ 加点しない", () => {
  expect(aixMetaKnowledgeBonus("初期費用", "見積", null)).toBe(0);
});
it("語の抽出: 2文字以上の漢字・カタカナ・重複と一般語を除く", () => {
  const w = extractMetaKeywords(["ペット可の物件はありますか", "ペット可物件をピックアップする"]);
  expect(w.includes("ペット可")).toBe(true);
  expect(w.includes("する")).toBe(false);
  expect(new Set(w).size).toBe(w.length);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
